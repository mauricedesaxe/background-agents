import { beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxRepository } from "./sandbox-repository";
import { decryptToken, generateEncryptionKey } from "../auth/crypto";
import type { SqlResult, SqlStorage } from "./sql-storage";
import type { Logger } from "../logger";

function createLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

function createMockSql() {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const data = new Map<string, unknown[]>();
  const written = new Map<string, number>();
  let defaultRowsWritten = 0;
  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      calls.push({ query, params });
      return {
        toArray: () => data.get(query) ?? [],
        one: () => null,
        rowsWritten: written.get(query) ?? defaultRowsWritten,
      };
    },
  };
  return {
    sql,
    calls,
    setData: (query: string, rows: unknown[]) => data.set(query, rows),
    setRowsWritten: (query: string, rows: number) => written.set(query, rows),
    setDefaultRowsWritten: (rows: number) => {
      defaultRowsWritten = rows;
    },
  };
}

const TEST_ENCRYPTION_KEY = generateEncryptionKey();

describe("SandboxRepository", () => {
  let mock: ReturnType<typeof createMockSql>;
  let repository: SandboxRepository;
  let log: Logger;

  beforeEach(() => {
    mock = createMockSql();
    log = createLog();
    repository = new SandboxRepository(mock.sql, log, TEST_ENCRYPTION_KEY);
  });

  describe("getSandbox", () => {
    it("returns null when no sandbox exists", () => {
      mock.setData(`SELECT * FROM sandbox LIMIT 1`, []);
      expect(repository.getSandbox()).toBeNull();
    });

    it("returns sandbox when it exists", () => {
      const sandbox = { id: "sb-1", status: "ready" };
      mock.setData(`SELECT * FROM sandbox LIMIT 1`, [sandbox]);
      expect(repository.getSandbox()).toEqual(sandbox);
    });

    // This is the read boundary for the sandbox row: the column is bare TEXT
    // with no CHECK constraint and roughly forty sites consume this status, so
    // validating here is what stops the same row meaning different things to
    // different callers. `failed` is the conservative landing spot -- it
    // refuses to reuse a sandbox we cannot classify while still allowing a
    // clean spawn, where `pending` would let it be picked up as if fresh.
    it("validates an unmodelled status to failed and warns", () => {
      mock.setData(`SELECT * FROM sandbox LIMIT 1`, [{ id: "sb-1", status: "running" }]);

      expect(repository.getSandbox()).toEqual({ id: "sb-1", status: "failed" });
      expect(log.warn).toHaveBeenCalledWith(
        "sandbox.status.unrecognized",
        expect.objectContaining({ status: "running" })
      );
    });

    it("leaves a missing status as pending without warning", () => {
      mock.setData(`SELECT * FROM sandbox LIMIT 1`, [{ id: "sb-1", status: null }]);

      expect(repository.getSandbox()).toEqual({ id: "sb-1", status: "pending" });
      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  describe("createSandbox", () => {
    it("creates sandbox with correct parameters", () => {
      repository.createSandbox({
        id: "sb-1",
        status: "pending",
        gitSyncStatus: "pending",
        createdAt: 1000,
      });

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("INSERT INTO sandbox");
      expect(mock.calls[0].params).toEqual(["sb-1", "pending", "pending", 1000]);
    });
  });

  describe("cold recovery", () => {
    it("encrypts the replacement token and fences the source in one transaction", async () => {
      repository = new SandboxRepository(mock.sql, log, TEST_ENCRYPTION_KEY);
      mock.setDefaultRowsWritten(1);

      await repository.beginColdRecovery({
        operationId: "recovery-1",
        sourceProviderObjectId: "source-provider",
        sourceSandboxId: "source-logical",
        sourceCreatedAt: 500,
        sourceRuntimeVersion: "43",
        snapshotName: "snapshot-recovery-1",
        replacementName: "replacement-recovery-1",
        replacementSandboxId: "replacement-logical",
        replacementAuthToken: "replacement-secret",
        targetCreatedAt: 1000,
      });

      const update = mock.calls.find((call) => call.query.includes("recovery_operation = ?"));
      expect(update?.query).toContain("auth_token_hash = ''");
      expect(update?.query).toContain("active_socket_id = ''");
      expect(update?.query).toContain("modal_object_id = ?");
      expect(update?.query).toContain("modal_sandbox_id = ?");
      expect(update?.query).toContain("created_at = ?");
      expect(update?.query).toContain("daytona_cold_recovery_committed");
      expect(update?.query).toContain("daytona_cold_recovery_failed");
      expect(update?.params.slice(1)).toEqual(["source-provider", "source-logical", 500]);
      const persisted = JSON.parse(String(update?.params[0]));
      expect(persisted.replacementAuthToken).toBeUndefined();
      expect(persisted.replacementAuthTokenEncrypted).not.toContain("replacement-secret");
      await expect(
        decryptToken(persisted.replacementAuthTokenEncrypted, TEST_ENCRYPTION_KEY)
      ).resolves.toBe("replacement-secret");
    });

    it("does not fence a source generation that changed while the token was encrypted", async () => {
      await expect(
        repository.beginColdRecovery({
          operationId: "recovery-1",
          sourceProviderObjectId: "source-provider",
          sourceSandboxId: "source-logical",
          sourceCreatedAt: 500,
          sourceRuntimeVersion: "43",
          snapshotName: "snapshot-recovery-1",
          replacementName: "replacement-recovery-1",
          replacementSandboxId: "replacement-logical",
          replacementAuthToken: "replacement-secret",
          targetCreatedAt: 1000,
        })
      ).rejects.toThrow("Could not persist sandbox recovery operation");

      const update = mock.calls.find((call) => call.query.includes("recovery_operation = ?"));
      expect(update?.params.slice(1)).toEqual(["source-provider", "source-logical", 500]);
    });

    it("atomically publishes replacement credentials and retains committed provenance", async () => {
      repository = new SandboxRepository(mock.sql, log, TEST_ENCRYPTION_KEY);
      mock.setDefaultRowsWritten(1);
      await repository.beginColdRecovery({
        operationId: "recovery-1",
        sourceProviderObjectId: "source-provider",
        sourceSandboxId: "source-logical",
        sourceCreatedAt: 500,
        sourceRuntimeVersion: null,
        snapshotName: "snapshot-recovery-1",
        replacementName: "replacement-recovery-1",
        replacementSandboxId: "replacement-logical",
        replacementAuthToken: "replacement-secret",
        targetCreatedAt: 1000,
      });
      const persisted = mock.calls.find((call) => call.query.includes("recovery_operation = ?"))
        ?.params[0];
      mock.setData(`SELECT * FROM sandbox LIMIT 1`, [
        { id: "row-1", status: "connecting", recovery_operation: persisted },
      ]);

      await expect(
        repository.completeColdRecovery({
          operationId: "recovery-1",
          providerObjectId: "replacement-provider",
          committedAt: 2000,
          codeServerUrl: "https://code.test",
          codeServerPassword: "code-secret",
        })
      ).resolves.toBe(true);

      const cutover = mock.calls.find((call) =>
        call.query.includes("git_sync_status = 'in_progress'")
      );
      expect(cutover?.query).toContain("modal_sandbox_id = ?");
      expect(cutover?.query).toContain("auth_token_hash = ?");
      expect(cutover?.params[0]).toBe("replacement-logical");
      expect(cutover?.params[1]).toBe("replacement-provider");
      expect(cutover?.params[3]).toBe(2000);
      expect(JSON.parse(String(cutover?.params.at(-2)))).toEqual(
        expect.objectContaining({
          kind: "daytona_cold_recovery_committed",
          operationId: "recovery-1",
          sourceProviderObjectId: "source-provider",
          sourceSandboxId: "source-logical",
          sourceCreatedAt: 500,
          sourceRuntimeVersion: null,
          snapshotName: "snapshot-recovery-1",
          replacementName: "replacement-recovery-1",
          replacementSandboxId: "replacement-logical",
          targetCreatedAt: 2000,
          replacementProviderObjectId: "replacement-provider",
          committedAt: 2000,
        })
      );
      expect(JSON.parse(String(cutover?.params.at(-2)))).not.toHaveProperty(
        "replacementAuthTokenEncrypted"
      );
      expect(cutover?.params.at(-1)).toBe("recovery-1");
    });

    it("parses recovering, committed, and failed states while exposing only active work", async () => {
      mock.setDefaultRowsWritten(1);
      await repository.beginColdRecovery({
        operationId: "recovery-1",
        sourceProviderObjectId: "source-provider",
        sourceSandboxId: "source-logical",
        sourceCreatedAt: 500,
        sourceRuntimeVersion: "43",
        snapshotName: "snapshot-recovery-1",
        replacementName: "replacement-recovery-1",
        replacementSandboxId: "replacement-logical",
        replacementAuthToken: "replacement-secret",
        targetCreatedAt: 1000,
      });
      const recovering = mock.calls.find((call) => call.query.includes("recovery_operation = ?"))
        ?.params[0];
      mock.setData(`SELECT * FROM sandbox LIMIT 1`, [
        { id: "row-1", status: "connecting", recovery_operation: recovering },
      ]);

      await expect(repository.getColdRecoveryOperation()).resolves.toEqual(
        expect.objectContaining({
          kind: "daytona_cold_recovery_recovering",
          replacementAuthToken: "replacement-secret",
        })
      );

      const base = {
        operationId: "recovery-1",
        sourceProviderObjectId: "source-provider",
        sourceSandboxId: "source-logical",
        sourceCreatedAt: 500,
        sourceRuntimeVersion: "43",
        snapshotName: "snapshot-recovery-1",
        replacementName: "replacement-recovery-1",
        replacementSandboxId: "replacement-logical",
        targetCreatedAt: 1000,
      };
      const committed = {
        ...base,
        kind: "daytona_cold_recovery_committed",
        replacementProviderObjectId: "replacement-provider",
        committedAt: 2000,
      };
      mock.setData(`SELECT * FROM sandbox LIMIT 1`, [
        { id: "row-1", status: "connecting", recovery_operation: JSON.stringify(committed) },
      ]);
      await expect(repository.getColdRecoveryState()).resolves.toEqual(committed);
      await expect(repository.getColdRecoveryOperation()).resolves.toBeNull();

      const failed = {
        ...base,
        kind: "daytona_cold_recovery_failed",
        failureClass: "permanent_provider_error",
        failureReason: "snapshot rejected",
        failedAt: 3000,
        retryPolicy: "supersede",
      };
      mock.setData(`SELECT * FROM sandbox LIMIT 1`, [
        { id: "row-1", status: "failed", recovery_operation: JSON.stringify(failed) },
      ]);
      await expect(repository.getColdRecoveryState()).resolves.toEqual(failed);
      await expect(repository.getColdRecoveryOperation()).resolves.toBeNull();
    });

    it.each([
      {
        kind: "daytona_cold_recovery_recovering",
        replacementAuthTokenEncrypted: "ciphertext",
      },
      {
        kind: "daytona_cold_recovery_committed",
        replacementProviderObjectId: "replacement-provider",
        committedAt: 2000,
      },
      {
        kind: "daytona_cold_recovery_failed",
        failureClass: "permanent_provider_error",
        failureReason: "snapshot rejected",
        failedAt: 2000,
      },
    ])("rejects an incomplete persisted $kind state at the storage boundary", async (state) => {
      mock.setData(`SELECT * FROM sandbox LIMIT 1`, [
        { id: "row-1", status: "failed", recovery_operation: JSON.stringify(state) },
      ]);

      await expect(repository.getColdRecoveryState()).rejects.toThrow(
        "Invalid persisted sandbox recovery operation"
      );
    });

    it("persists a classified terminal failure so a later operation can supersede it", async () => {
      mock.setDefaultRowsWritten(1);
      await repository.beginColdRecovery({
        operationId: "recovery-1",
        sourceProviderObjectId: "source-provider",
        sourceSandboxId: "source-logical",
        sourceCreatedAt: 500,
        sourceRuntimeVersion: null,
        snapshotName: "snapshot-recovery-1",
        replacementName: "replacement-recovery-1",
        replacementSandboxId: "replacement-logical",
        replacementAuthToken: "replacement-secret",
        targetCreatedAt: 1000,
      });
      const recovering = mock.calls.find((call) => call.query.includes("recovery_operation = ?"))
        ?.params[0];
      mock.setData(`SELECT * FROM sandbox LIMIT 1`, [
        { id: "row-1", status: "connecting", recovery_operation: recovering },
      ]);

      await expect(
        repository.failColdRecovery({
          operationId: "recovery-1",
          failureReason: "invalid source state",
          failedAt: 2000,
        })
      ).resolves.toBe(true);

      const failureWrite = mock.calls.find((call) =>
        call.query.includes("kind') = 'daytona_cold_recovery_recovering'")
      );
      expect(JSON.parse(String(failureWrite?.params[0]))).toEqual(
        expect.objectContaining({
          kind: "daytona_cold_recovery_failed",
          sourceProviderObjectId: "source-provider",
          failureClass: "permanent_provider_error",
          failureReason: "invalid source state",
          retryPolicy: "supersede",
        })
      );
    });
  });

  describe("updateSandboxStatus", () => {
    it("updates status", () => {
      repository.updateSandboxStatus("ready");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET status");
      expect(mock.calls[0].params).toEqual(["ready"]);
    });
  });

  describe("transitionSandboxStatus", () => {
    const query = `UPDATE sandbox SET status = ?
       WHERE id = (SELECT id FROM sandbox LIMIT 1)
         AND modal_sandbox_id IS ? AND created_at = ? AND status = ?`;
    const generation = { sandboxId: "modal-sb-1", createdAt: 5000 };

    it("moves the row only while it is still the generation's and in the expected status", () => {
      mock.setRowsWritten(query, 1);

      expect(repository.transitionSandboxStatus(generation, "snapshotting", "ready")).toBe(true);
      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toBe(query);
      expect(mock.calls[0].params).toEqual(["ready", "modal-sb-1", 5000, "snapshotting"]);
    });

    it("reports a row that another event or attempt moved instead of overwriting it", () => {
      expect(repository.transitionSandboxStatus(generation, "spawning", "connecting")).toBe(false);
    });
  });

  describe("updateSandboxForSpawn", () => {
    it("sets all spawn fields atomically and invalidates credentials", () => {
      repository.updateSandboxForSpawn({
        status: "spawning",
        createdAt: 1000,
        modalSandboxId: "modal-sb-1",
      });

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET");
      expect(mock.calls[0].query).toContain("status");
      expect(mock.calls[0].query).toContain("modal_sandbox_id");
      // The reservation itself empties the hash (#1589 phase 1) — no caller
      // can accidentally reserve with live credentials.
      expect(mock.calls[0].query).toContain("auth_token_hash = ''");
      expect(mock.calls[0].query).toContain("auth_token = NULL");
      expect(mock.calls[0].query).toContain("modal_object_id = NULL");
      expect(mock.calls[0].query).toContain("vnc_url = NULL");
      expect(mock.calls[0].query).toContain("vnc_password = NULL");
      // A replacement sandbox must not inherit the predecessor's runtime.
      expect(mock.calls[0].query).toContain("runtime_version = NULL");
      // ...nor its bridge: the predecessor's socket loses dispatch authority
      // here. Revoked is '' — NULL is reserved for rows that predate identities.
      expect(mock.calls[0].query).toContain("active_socket_id = ''");
      expect(mock.calls[0].query).toContain("git_sync_status = 'in_progress'");
      expect(mock.calls[0].params).toEqual(["spawning", 1000, "modal-sb-1"]);
    });

    it("can preserve the provider object ID while fencing a replacement", () => {
      repository.updateSandboxForSpawn({
        status: "spawning",
        createdAt: 123,
        modalSandboxId: "sandbox-new",
        preserveProviderObjectId: true,
      });

      expect(mock.calls[0].query).toContain("modal_object_id = modal_object_id");
    });
  });

  describe("updateSandboxForResume", () => {
    it("resets git sync status in the resume reservation", () => {
      repository.updateSandboxForResume({ status: "connecting", createdAt: 1000 });

      expect(mock.calls[0].query).toContain("git_sync_status = 'in_progress'");
      expect(mock.calls[0].params).toEqual(["connecting", 1000]);
    });
  });

  describe("active socket id", () => {
    it("writes the identity to the session's one sandbox row", () => {
      repository.setActiveSocketId("sbws-2");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET active_socket_id = ?");
      expect(mock.calls[0].params).toEqual(["sbws-2"]);
    });

    it("revokes with the empty sentinel rather than NULL", () => {
      repository.revokeActiveSocketId();

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET active_socket_id = ''");
      expect(mock.calls[0].params).toEqual([]);
    });
  });

  describe("updateSandboxAuthTokenHash", () => {
    const query = `UPDATE sandbox SET auth_token_hash = ? WHERE modal_sandbox_id = ? AND status = 'spawning'`;

    it("publishes the hash scoped to the reserved identity", () => {
      mock.setRowsWritten(query, 1);

      expect(repository.updateSandboxAuthTokenHash("modal-sb-1", "hash-1")).toBe(true);
      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toBe(query);
      expect(mock.calls[0].params).toEqual(["hash-1", "modal-sb-1"]);
    });

    it("reports a superseded or stopped reservation instead of touching the current row", () => {
      expect(repository.updateSandboxAuthTokenHash("modal-sb-stale", "hash-1")).toBe(false);
    });
  });

  describe("updateSandboxModalObjectId", () => {
    it("updates modal object ID", () => {
      repository.updateSandboxModalObjectId("obj-123");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET modal_object_id");
      expect(mock.calls[0].params).toEqual(["obj-123"]);
    });
  });

  describe("recordSandboxSnapshot", () => {
    const query = `UPDATE sandbox SET snapshot_image_id = ?, snapshot_runtime_version = ?
       WHERE id = (SELECT id FROM sandbox LIMIT 1) AND modal_sandbox_id IS ?`;

    it("stamps the snapshot with the runtime that produced it, for the sandbox it was taken of", () => {
      mock.setRowsWritten(query, 1);

      expect(repository.recordSandboxSnapshot("modal-sb-1", "img-123", "v59-runtime")).toBe(true);
      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toBe(query);
      expect(mock.calls[0].params).toEqual(["img-123", "v59-runtime", "modal-sb-1"]);
    });

    it("records a null runtime when the sandbox never reported one", () => {
      repository.recordSandboxSnapshot("modal-sb-1", "img-123", null);

      expect(mock.calls[0].params).toEqual(["img-123", null, "modal-sb-1"]);
    });

    it("reports a replaced sandbox instead of stamping its successor", () => {
      expect(repository.recordSandboxSnapshot("modal-sb-old", "img-123", null)).toBe(false);
    });
  });

  describe("updateSandboxRuntimeVersion", () => {
    it("records the running sandbox's runtime version", () => {
      repository.updateSandboxRuntimeVersion("v59-runtime");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET runtime_version");
      expect(mock.calls[0].params).toEqual(["v59-runtime"]);
    });

    it("clears the recorded version when set to null", () => {
      repository.updateSandboxRuntimeVersion(null);

      expect(mock.calls[0].params).toEqual([null]);
    });
  });

  describe("recordReportedSandboxRuntimeVersion", () => {
    it("only fills a row with nothing recorded yet", () => {
      repository.recordReportedSandboxRuntimeVersion("v59-runtime");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET runtime_version");
      // A restore seeds the snapshot's version first; the sandbox's own report
      // must not overwrite it.
      expect(mock.calls[0].query).toContain("runtime_version IS NULL");
      expect(mock.calls[0].params).toEqual(["v59-runtime"]);
    });
  });

  describe("updateSandboxHeartbeat", () => {
    it("updates heartbeat timestamp", () => {
      repository.updateSandboxHeartbeat(5000);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET last_heartbeat");
      expect(mock.calls[0].params).toEqual([5000]);
    });
  });

  describe("updateSandboxLastActivity", () => {
    it("updates activity timestamp", () => {
      repository.updateSandboxLastActivity(6000);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET last_activity");
      expect(mock.calls[0].params).toEqual([6000]);
    });
  });

  describe("updateSandboxGitSyncStatus", () => {
    it("updates git sync status", () => {
      repository.updateSandboxGitSyncStatus("completed");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET git_sync_status");
      expect(mock.calls[0].params).toEqual(["completed"]);
    });
  });

  describe("completeSandboxGitSync", () => {
    it("claims a terminal transition only from in_progress", () => {
      mock.setDefaultRowsWritten(1);

      expect(repository.completeSandboxGitSync("completed")).toBe(true);

      expect(mock.calls[0].query).toContain("git_sync_status = 'in_progress'");
      expect(mock.calls[0].params).toEqual(["completed"]);
    });
  });

  describe("setLastSpawnError", () => {
    it("updates spawn error fields", () => {
      repository.setLastSpawnError("Failed to spawn sandbox", 123456);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET last_spawn_error");
      expect(mock.calls[0].params).toEqual(["Failed to spawn sandbox", 123456]);
    });
  });

  describe("access artifacts", () => {
    it("stores encrypted credentials and clears them", async () => {
      await repository.updateSandboxAccess("vnc", "https://vnc.test", "vnc-secret");
      repository.clearSandboxAccess("vnc");

      expect(mock.calls[0].query).toContain("SET vnc_url = ?, vnc_password = ?");
      const [url, stored] = mock.calls[0].params as [string, string];
      expect(url).toBe("https://vnc.test");
      expect(stored).not.toBe("vnc-secret");
      await expect(decryptToken(stored, TEST_ENCRYPTION_KEY)).resolves.toBe("vnc-secret");
      expect(mock.calls[1].query).toContain("SET vnc_url = NULL, vnc_password = NULL");
    });

    it("encrypts code-server and ttyd secrets the same way", async () => {
      await repository.updateSandboxAccess("codeServer", "https://cs.test", "cs-secret");
      await repository.updateSandboxAccess("ttyd", "https://ttyd.test", "ttyd-token");

      expect(mock.calls[0].query).toContain("SET code_server_url = ?, code_server_password = ?");
      expect(mock.calls[1].query).toContain("SET ttyd_url = ?, ttyd_token = ?");
      for (const [call, plaintext] of [
        [mock.calls[0], "cs-secret"],
        [mock.calls[1], "ttyd-token"],
      ] as const) {
        const stored = call.params[1] as string;
        expect(stored).not.toBe(plaintext);
        await expect(decryptToken(stored, TEST_ENCRYPTION_KEY)).resolves.toBe(plaintext);
      }
    });

    it("can clear only the URL", () => {
      repository.clearSandboxAccessUrl("vnc");

      expect(mock.calls[0].query).toContain("SET vnc_url = NULL");
      expect(mock.calls[0].query).not.toContain("vnc_password");
    });
  });

  describe("resetCircuitBreaker", () => {
    it("resets failure count to zero", () => {
      repository.resetCircuitBreaker();

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("spawn_failure_count = 0");
    });
  });

  describe("incrementCircuitBreakerFailure", () => {
    it("increments count and sets timestamp", () => {
      repository.incrementCircuitBreakerFailure(7000);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("spawn_failure_count = COALESCE");
      expect(mock.calls[0].query).toContain("last_spawn_failure");
      expect(mock.calls[0].params).toEqual([7000]);
    });
  });
});
