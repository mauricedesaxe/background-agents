/**
 * Unit tests for DaytonaSandboxProvider.
 *
 * Tests env-var assembly, label construction, code-server password derivation,
 * tunnel URL generation, and error handling for create/resume/stop flows.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { computeHmacHex } from "@open-inspect/shared";
import { DaytonaSandboxProvider, type DaytonaProviderConfig } from "./daytona-provider";
import { SandboxProviderError } from "../provider";
import type { ArchiveConfig, CreateSandboxConfig, ResumeConfig, StopConfig } from "../provider";
import {
  DaytonaNotFoundError,
  DaytonaApiError,
  type DaytonaRestClient,
  type DaytonaSandboxResponse,
  type DaytonaSignedPreviewUrlResponse,
  type DaytonaCreateSandboxParams,
  type DaytonaRestConfig,
} from "../daytona-rest-client";

// ==================== Mock Factories ====================

const defaultRestConfig: DaytonaRestConfig = {
  apiUrl: "https://daytona.test/api",
  apiKey: "test-api-key",
  baseSnapshot: "base-snapshot-v1",
  autoStopIntervalMinutes: 120,
  autoArchiveIntervalMinutes: 1440,
};

function createMockClient(
  overrides: Partial<{
    createSandbox: (params: DaytonaCreateSandboxParams) => Promise<DaytonaSandboxResponse>;
    getSandbox: (id: string) => Promise<DaytonaSandboxResponse>;
    startSandbox: (id: string) => Promise<void>;
    stopSandbox: (id: string) => Promise<void>;
    archiveSandbox: (id: string) => Promise<void>;
    recoverSandbox: (id: string) => Promise<void>;
    getSignedPreviewUrl: (
      id: string,
      port: number,
      expiry: number
    ) => Promise<DaytonaSignedPreviewUrlResponse>;
  }> = {},
  configOverrides: Partial<DaytonaRestConfig> = {}
): DaytonaRestClient {
  return {
    config: { ...defaultRestConfig, ...configOverrides },
    createSandbox: vi.fn(
      async (): Promise<DaytonaSandboxResponse> => ({
        id: "daytona-sandbox-id",
        state: "started",
      })
    ),
    getSandbox: vi.fn(
      async (): Promise<DaytonaSandboxResponse> => ({
        id: "daytona-sandbox-id",
        state: "started",
      })
    ),
    startSandbox: vi.fn(async () => {}),
    stopSandbox: vi.fn(async () => {}),
    archiveSandbox: vi.fn(async () => {}),
    recoverSandbox: vi.fn(async () => {}),
    getSignedPreviewUrl: vi.fn(
      async (): Promise<DaytonaSignedPreviewUrlResponse> => ({
        url: "https://preview.test/signed",
      })
    ),
    ...overrides,
  } as unknown as DaytonaRestClient;
}

const defaultProviderConfig: DaytonaProviderConfig = {
  scmProvider: "github",
  codeServerPasswordSecret: "test-secret-key",
};

const baseCreateConfig: CreateSandboxConfig = {
  sessionId: "session-123",
  sandboxId: "sandbox-456",
  repoOwner: "testowner",
  repoName: "testrepo",
  controlPlaneUrl: "https://control-plane.test",
  sandboxAuthToken: "auth-token-abc",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
};

const baseResumeConfig: ResumeConfig = {
  providerObjectId: "daytona-sandbox-id",
  sessionId: "session-123",
  sandboxId: "sandbox-456",
};

const baseStopConfig: StopConfig = {
  providerObjectId: "daytona-sandbox-id",
  sessionId: "session-123",
  reason: "inactivity_timeout",
};

const baseArchiveConfig: ArchiveConfig = {
  providerObjectId: "daytona-sandbox-id",
  sessionId: "session-123",
  reason: "session_archived",
};

// ==================== Tests ====================

describe("DaytonaSandboxProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("capabilities", () => {
    it("reports correct capabilities", () => {
      const provider = new DaytonaSandboxProvider(createMockClient(), defaultProviderConfig);
      expect(provider.name).toBe("daytona");
      expect(provider.capabilities).toEqual({
        supportsSnapshots: false,
        supportsRestore: false,
        supportsPersistentResume: true,
        supportsExplicitStop: true,
        supportsArchive: true,
      });
    });
  });

  describe("createSandbox", () => {
    it("happy path: creates sandbox with env vars, labels, and tunnel URLs", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.createSandbox(baseCreateConfig);

      expect(result.sandboxId).toBe("sandbox-456");
      expect(result.providerObjectId).toBe("daytona-sandbox-id");
      expect(result.status).toBe("started");
      expect(result.createdAt).toBeGreaterThan(0);

      // Verify create was called with correct params
      const createCall = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.name).toBe("sandbox-456");
      expect(createCall.snapshot).toBe("base-snapshot-v1");
      expect(createCall.autoStopInterval).toBe(120);
      expect(createCall.autoArchiveInterval).toBe(1440);
      expect(createCall.public).toBe(false);
      // Daytona rejects a snapshot-based create that specifies resources, so we
      // must not send cpu/memory/disk here (sizing lives on the snapshot).
      expect(createCall.cpu).toBeUndefined();
      expect(createCall.memory).toBeUndefined();
      expect(createCall.disk).toBeUndefined();
    });

    it("assembles env vars correctly for GitHub, without embedding any token", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const createCall = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const envVars = createCall.env;

      expect(envVars.PYTHONUNBUFFERED).toBe("1");
      expect(envVars.SANDBOX_ID).toBe("sandbox-456");
      expect(envVars.CONTROL_PLANE_URL).toBe("https://control-plane.test");
      expect(envVars.SANDBOX_AUTH_TOKEN).toBe("auth-token-abc");
      expect(envVars.REPO_OWNER).toBe("testowner");
      expect(envVars.REPO_NAME).toBe("testrepo");
      expect(envVars.VCS_HOST).toBe("github.com");
      expect(envVars.VCS_CLONE_USERNAME).toBe("x-access-token");
      // Git authenticates via the sandbox credential helper, not env vars.
      expect(envVars.VCS_CLONE_TOKEN).toBeUndefined();
      expect(envVars.GITHUB_APP_TOKEN).toBeUndefined();
      expect(envVars.GITHUB_TOKEN).toBeUndefined();

      const sessionConfig = JSON.parse(envVars.SESSION_CONFIG);
      expect(sessionConfig).toEqual({
        session_id: "session-123",
        repo_owner: "testowner",
        repo_name: "testrepo",
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-5",
      });
    });

    it("assembles env vars correctly for GitLab", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, {
        scmProvider: "gitlab",
        gitlabAccessToken: "glpat-test-token",
        codeServerPasswordSecret: "secret",
      });

      await provider.createSandbox(baseCreateConfig);

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      expect(envVars.VCS_HOST).toBe("gitlab.com");
      expect(envVars.VCS_CLONE_USERNAME).toBe("oauth2");
      expect(envVars.VCS_CLONE_TOKEN).toBeUndefined();
    });

    it("includes branch in SESSION_CONFIG when provided", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({ ...baseCreateConfig, branch: "feature/test" });

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      const sessionConfig = JSON.parse(envVars.SESSION_CONFIG);
      expect(sessionConfig.branch).toBe("feature/test");
    });

    it("includes mcp_servers in SESSION_CONFIG when provided", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({
        ...baseCreateConfig,
        mcpServers: [{ id: "mcp-1", name: "Tool", type: "local", enabled: true }],
      });

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      const sessionConfig = JSON.parse(envVars.SESSION_CONFIG);
      expect(sessionConfig.mcp_servers).toEqual([
        { id: "mcp-1", name: "Tool", type: "local", enabled: true },
      ]);
    });

    it("includes user env vars (repo secrets) with system vars taking precedence", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({
        ...baseCreateConfig,
        userEnvVars: { MY_SECRET: "value123", SANDBOX_ID: "should-be-overridden" },
      });

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      expect(envVars.MY_SECRET).toBe("value123");
      // System var overrides user-provided duplicate
      expect(envVars.SANDBOX_ID).toBe("sandbox-456");
    });

    it("builds labels correctly", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const createCall = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const labels = createCall.labels;
      expect(labels).toEqual({
        openinspect_framework: "open-inspect",
        openinspect_session_id: "session-123",
        openinspect_repo: "testowner/testrepo",
        openinspect_expected_sandbox_id: "sandbox-456",
      });
    });

    it("omits repo label for no-repository sandboxes", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({
        ...baseCreateConfig,
        repoOwner: null,
        repoName: null,
      });

      const createCall = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.env).toMatchObject({
        REPO_OWNER: "",
        REPO_NAME: "",
      });
      const labels = createCall.labels;
      expect(labels).toEqual({
        openinspect_framework: "open-inspect",
        openinspect_session_id: "session-123",
        openinspect_expected_sandbox_id: "sandbox-456",
      });
    });

    it("passes target to create params when set", async () => {
      const client = createMockClient({}, { target: "us-east-1" });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const createCall = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.target).toBe("us-east-1");
    });

    it("omits target from create params when not set", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const createCall = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.target).toBeUndefined();
    });

    it("never embeds a token in the sandbox environment", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      expect(envVars.VCS_CLONE_TOKEN).toBeUndefined();
      expect(envVars.GITHUB_APP_TOKEN).toBeUndefined();
      expect(envVars.GITHUB_TOKEN).toBeUndefined();
    });

    it("sets AGENT_SLACK_NOTIFY_ENABLED=true when agentSlackNotifyEnabled is on", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({ ...baseCreateConfig, agentSlackNotifyEnabled: true });

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      expect(envVars.AGENT_SLACK_NOTIFY_ENABLED).toBe("true");
    });

    it("omits AGENT_SLACK_NOTIFY_ENABLED when disabled (absent key, not 'false')", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      expect(envVars.AGENT_SLACK_NOTIFY_ENABLED).toBeUndefined();
    });

    it("omits AGENT_SLACK_NOTIFY_ENABLED when explicitly false", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({ ...baseCreateConfig, agentSlackNotifyEnabled: false });

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      expect(envVars.AGENT_SLACK_NOTIFY_ENABLED).toBeUndefined();
    });

    it("classifies DaytonaApiError as SandboxProviderError", async () => {
      const client = createMockClient({
        createSandbox: async () => {
          throw new DaytonaApiError("quota exceeded", 422);
        },
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      try {
        await provider.createSandbox(baseCreateConfig);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("permanent");
      }
    });

    it("classifies 502 as transient error", async () => {
      const client = createMockClient({
        createSandbox: async () => {
          throw new DaytonaApiError("bad gateway", 502);
        },
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      try {
        await provider.createSandbox(baseCreateConfig);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });
  });

  describe("code-server password derivation", () => {
    it("derives deterministic password via HMAC", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({
        ...baseCreateConfig,
        codeServerEnabled: true,
      });

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      const expectedDigest = await computeHmacHex("code-server:sandbox-456", "test-secret-key");
      expect(envVars.CODE_SERVER_PASSWORD).toBe(expectedDigest.slice(0, 32));
      expect(envVars.CODE_SERVER_PASSWORD).toHaveLength(32);
    });

    it("does not set CODE_SERVER_PASSWORD when disabled", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      expect(envVars.CODE_SERVER_PASSWORD).toBeUndefined();
    });
  });

  describe("resumeSandbox", () => {
    it("happy path: resumes a stopped sandbox", async () => {
      const client = createMockClient({
        getSandbox: async () => ({ id: "daytona-sandbox-id", state: "stopped" }),
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.resumeSandbox(baseResumeConfig);

      expect(result.success).toBe(true);
      expect(result.providerObjectId).toBe("daytona-sandbox-id");
      expect(client.startSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
    });

    it("returns shouldSpawnFresh when sandbox not found", async () => {
      const client = createMockClient({
        getSandbox: async () => {
          throw new DaytonaNotFoundError("not found");
        },
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.resumeSandbox(baseResumeConfig);

      expect(result.success).toBe(false);
      expect(result.shouldSpawnFresh).toBe(true);
    });

    it("recovers sandbox in error state when recoverable", async () => {
      const client = createMockClient({
        getSandbox: async () => ({
          id: "daytona-sandbox-id",
          state: "error",
          recoverable: true,
        }),
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.resumeSandbox(baseResumeConfig);

      expect(client.recoverSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
      expect(client.startSandbox).not.toHaveBeenCalled();
    });

    it("recovers sandbox in build_failed state when recoverable", async () => {
      const client = createMockClient({
        getSandbox: async () => ({
          id: "daytona-sandbox-id",
          state: "build_failed",
          recoverable: true,
        }),
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.resumeSandbox(baseResumeConfig);

      expect(client.recoverSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
    });

    it("starts sandbox in error state when not recoverable", async () => {
      const client = createMockClient({
        getSandbox: async () => ({
          id: "daytona-sandbox-id",
          state: "error",
          recoverable: false,
        }),
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.resumeSandbox(baseResumeConfig);

      expect(client.startSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
      expect(client.recoverSandbox).not.toHaveBeenCalled();
    });

    it("does not start or recover when already started", async () => {
      const client = createMockClient({
        getSandbox: async () => ({ id: "daytona-sandbox-id", state: "started" }),
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.resumeSandbox(baseResumeConfig);

      expect(result.success).toBe(true);
      expect(client.startSandbox).not.toHaveBeenCalled();
      expect(client.recoverSandbox).not.toHaveBeenCalled();
    });

    it("tunnel URL failure does not fail the resume", async () => {
      const client = createMockClient({
        getSandbox: async () => ({ id: "daytona-sandbox-id", state: "stopped" }),
        getSignedPreviewUrl: async () => {
          throw new Error("tunnel service down");
        },
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.resumeSandbox({
        ...baseResumeConfig,
        codeServerEnabled: true,
      });

      expect(result.success).toBe(true);
      expect(result.codeServerUrl).toBeUndefined();
    });
  });

  describe("stopSandbox", () => {
    it("happy path: stops sandbox", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.stopSandbox(baseStopConfig);

      expect(result.success).toBe(true);
      expect(client.stopSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
    });

    it("returns success when sandbox not found (already gone)", async () => {
      const client = createMockClient({
        stopSandbox: async () => {
          throw new DaytonaNotFoundError("not found");
        },
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.stopSandbox(baseStopConfig);

      expect(result.success).toBe(true);
    });

    it("classifies non-404 errors as SandboxProviderError", async () => {
      const client = createMockClient({
        stopSandbox: async () => {
          throw new DaytonaApiError("service unavailable", 503);
        },
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      try {
        await provider.stopSandbox(baseStopConfig);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });

    it("retries the stop while the sandbox is still settling (409)", async () => {
      vi.useFakeTimers();
      try {
        const client = createMockClient({
          stopSandbox: vi
            .fn()
            .mockRejectedValueOnce(new DaytonaApiError("Sandbox state change in progress", 409))
            .mockRejectedValueOnce(new DaytonaApiError("Sandbox state change in progress", 409))
            .mockResolvedValueOnce(undefined),
        });
        const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

        const pending = provider.stopSandbox(baseStopConfig);
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(result.success).toBe(true);
        expect(client.stopSandbox).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives up and reports failure when the sandbox never settles", async () => {
      vi.useFakeTimers();
      try {
        const client = createMockClient({
          stopSandbox: vi
            .fn()
            .mockRejectedValue(new DaytonaApiError("Sandbox state change in progress", 409)),
        });
        const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

        const pending = provider.stopSandbox(baseStopConfig);
        const settled = expect(pending).rejects.toBeInstanceOf(SandboxProviderError);
        await vi.runAllTimersAsync();
        await settled;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("archiveSandbox", () => {
    it("stops a running sandbox before archiving it", async () => {
      const client = createMockClient({
        getSandbox: async () => ({ id: "daytona-sandbox-id", state: "started" }),
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.archiveSandbox(baseArchiveConfig);

      expect(result.success).toBe(true);
      expect(client.stopSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
      expect(client.archiveSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
    });

    it("archives a stopped sandbox without stopping it again", async () => {
      const client = createMockClient({
        getSandbox: async () => ({ id: "daytona-sandbox-id", state: "stopped" }),
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.archiveSandbox(baseArchiveConfig);

      expect(result.success).toBe(true);
      expect(client.stopSandbox).not.toHaveBeenCalled();
      expect(client.archiveSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
    });

    it("is a no-op when the sandbox is already archived", async () => {
      const client = createMockClient({
        getSandbox: async () => ({ id: "daytona-sandbox-id", state: "archived" }),
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.archiveSandbox(baseArchiveConfig);

      expect(result.success).toBe(true);
      expect(client.stopSandbox).not.toHaveBeenCalled();
      expect(client.archiveSandbox).not.toHaveBeenCalled();
    });

    it("returns success when the sandbox is already gone (404)", async () => {
      const client = createMockClient({
        getSandbox: async () => {
          throw new DaytonaNotFoundError("not found");
        },
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.archiveSandbox(baseArchiveConfig);

      expect(result.success).toBe(true);
      expect(client.archiveSandbox).not.toHaveBeenCalled();
    });

    it("retries the archive while the stop is still settling (409)", async () => {
      vi.useFakeTimers();
      try {
        const client = createMockClient({
          getSandbox: async () => ({ id: "daytona-sandbox-id", state: "started" }),
          archiveSandbox: vi
            .fn()
            .mockRejectedValueOnce(new DaytonaApiError("Sandbox state change in progress", 409))
            .mockRejectedValueOnce(new DaytonaApiError("Sandbox state change in progress", 409))
            .mockResolvedValueOnce(undefined),
        });
        const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

        const pending = provider.archiveSandbox(baseArchiveConfig);
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(result.success).toBe(true);
        expect(client.stopSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
        expect(client.archiveSandbox).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("classifies a failed archive as SandboxProviderError", async () => {
      const client = createMockClient({
        getSandbox: async () => ({ id: "daytona-sandbox-id", state: "stopped" }),
        archiveSandbox: async () => {
          throw new DaytonaApiError("service unavailable", 503);
        },
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      try {
        await provider.archiveSandbox(baseArchiveConfig);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });
  });
});
