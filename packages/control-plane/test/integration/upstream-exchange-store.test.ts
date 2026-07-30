import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { UpstreamExchangeStore } from "../../src/db/upstream-exchange-store";
import { cleanD1Tables } from "./cleanup";

const AUTOMATION_ID = "automation-exchange";
const RUN_ONE = "run-one";
const RUN_TWO = "run-two";
const SHA_ONE = "1".repeat(40);
const SHA_TWO = "2".repeat(40);
const FORK_HEAD = "a".repeat(40);
const MERGE_BASE = "b".repeat(40);

describe("UpstreamExchangeStore", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO automations
       (id, name, instructions, trigger_type, schedule_cron, schedule_tz, model,
        reasoning_effort, enabled, next_run_at, consecutive_failures, created_by,
        user_id, created_at, updated_at, deleted_at, event_type, trigger_config,
        trigger_auth_data)
       VALUES (?, 'Exchange', 'Report', 'schedule', '0 9 * * *', 'UTC',
        'openai/gpt-5.6-sol', 'high', 1, NULL, 0, 'test', NULL, ?, ?, NULL,
        NULL, NULL, NULL)`
      ).bind(AUTOMATION_ID, now, now),
      env.DB.prepare(
        `INSERT INTO automation_invocations
       (id, automation_id, source, scheduled_at, trigger_key, concurrency_key,
        trigger_metadata, skip_reason, failure_counted_at, created_at, updated_at)
       VALUES ('invocation-one', ?, 'schedule', ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`
      ).bind(AUTOMATION_ID, now, now, now),
      env.DB.prepare(
        `INSERT INTO automation_invocations
       (id, automation_id, source, scheduled_at, trigger_key, concurrency_key,
        trigger_metadata, skip_reason, failure_counted_at, created_at, updated_at)
       VALUES ('invocation-two', ?, 'schedule', ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`
      ).bind(AUTOMATION_ID, now + 1, now + 1, now + 1),
      env.DB.prepare(
        `INSERT INTO automation_runs
       (id, automation_id, invocation_id, session_id, status, skip_reason,
        failure_reason, scheduled_at, started_at, completed_at, created_at,
        repo_owner, repo_name, repo_id, base_branch, environment_id, prompt_content,
        repository_set)
       VALUES (?, ?, 'invocation-two', NULL, 'running', NULL, NULL, ?, ?, NULL, ?,
        'mauricedesaxe', 'background-agents', NULL, 'main', NULL, NULL, NULL)`
      ).bind(RUN_ONE, AUTOMATION_ID, now, now, now),
      env.DB.prepare(
        `INSERT INTO automation_runs
       (id, automation_id, invocation_id, session_id, status, skip_reason,
        failure_reason, scheduled_at, started_at, completed_at, created_at,
        repo_owner, repo_name, repo_id, base_branch, environment_id, prompt_content,
        repository_set)
       VALUES (?, ?, 'invocation-one', NULL, 'running', NULL, NULL, ?, ?, NULL, ?,
        'mauricedesaxe', 'background-agents', NULL, 'main', NULL, NULL, NULL)`
      ).bind(RUN_TWO, AUTOMATION_ID, now, now, now + 1),
    ]);
  });

  afterEach(cleanD1Tables);

  it("advances only a complete Slack-delivered range and reuses durable dispositions", async () => {
    const store = new UpstreamExchangeStore(env.DB);
    await store.beginScan({
      id: crypto.randomUUID(),
      automationId: AUTOMATION_ID,
      automationRunId: RUN_ONE,
      direction: "inbound",
      sourceRepository: "ColeMurray/background-agents",
      fromSha: null,
      toSha: SHA_TWO,
      forkHeadSha: FORK_HEAD,
      upstreamHeadSha: SHA_TWO,
      mergeBaseSha: MERGE_BASE,
      expectedCommitShas: [SHA_ONE, SHA_TWO],
    });

    expect(await store.finalizeForRun(RUN_ONE)).toMatchObject({
      kind: "blocked",
      reason: "Slack delivery receipt is missing",
    });
    expect(await store.getCursor(AUTOMATION_ID, "inbound", "ColeMurray/background-agents")).toBe(
      null
    );

    const scan = await env.DB.prepare(
      "SELECT id FROM upstream_exchange_scans WHERE automation_run_id = ?"
    )
      .bind(RUN_ONE)
      .first<{ id: string }>();
    const disposition = {
      classification: "clean_candidate" as const,
      evidence: "Touches only shared scheduler code.",
      affectedPackages: ["control-plane"],
      terraformImpact: "none",
      migrationImpact: "none",
      divergenceEntries: [],
      testHandMerge: false,
      semanticPortEvidence: "not present locally",
      usefulUnit: null,
      proposedArtifact: null,
    };
    await expect(
      store.recordDisposition({
        scanId: scan!.id,
        automationId: AUTOMATION_ID,
        automationRunId: RUN_ONE,
        commitSha: SHA_ONE,
        disposition: { ...disposition, classification: "candidate" },
      })
    ).rejects.toThrow("Classification does not apply to inbound scans");
    await store.recordDisposition({
      scanId: scan!.id,
      automationId: AUTOMATION_ID,
      automationRunId: RUN_ONE,
      commitSha: SHA_ONE,
      disposition,
    });
    expect(
      await store.recordDisposition({
        scanId: scan!.id,
        automationId: AUTOMATION_ID,
        automationRunId: RUN_ONE,
        commitSha: SHA_ONE,
        disposition,
      })
    ).toEqual({ repeated: true });
    await store.recordSlackDelivery({
      scanId: scan!.id,
      automationId: AUTOMATION_ID,
      automationRunId: RUN_ONE,
      channelId: "C123",
      messageTs: "1.2",
      permalink: "https://slack.test/1",
    });
    expect(await store.finalizeForRun(RUN_ONE)).toMatchObject({
      kind: "blocked",
      reason: "1 expected commits have no disposition",
    });

    await store.recordDisposition({
      scanId: scan!.id,
      automationId: AUTOMATION_ID,
      automationRunId: RUN_ONE,
      commitSha: SHA_TWO,
      disposition: { ...disposition, classification: "needs_decision" },
    });
    expect(await store.finalizeForRun(RUN_ONE)).toMatchObject({ kind: "finalized" });
    expect(await store.getCursor(AUTOMATION_ID, "inbound", "ColeMurray/background-agents")).toBe(
      SHA_TWO
    );
    expect(await store.finalizeForRun(RUN_ONE)).toMatchObject({ kind: "finalized" });
  });

  it("rejects a scan that starts behind the finalized cursor", async () => {
    const store = new UpstreamExchangeStore(env.DB);
    const firstId = crypto.randomUUID();
    await store.beginScan({
      id: firstId,
      automationId: AUTOMATION_ID,
      automationRunId: RUN_ONE,
      direction: "outbound",
      sourceRepository: "mauricedesaxe/background-agents",
      fromSha: null,
      toSha: SHA_ONE,
      forkHeadSha: SHA_ONE,
      upstreamHeadSha: FORK_HEAD,
      mergeBaseSha: MERGE_BASE,
      expectedCommitShas: [],
    });
    await store.recordSlackDelivery({
      scanId: firstId,
      automationId: AUTOMATION_ID,
      automationRunId: RUN_ONE,
      channelId: "C123",
      messageTs: "1.2",
      permalink: "https://slack.test/1",
    });
    await store.finalizeForRun(RUN_ONE);

    await expect(
      store.beginScan({
        id: crypto.randomUUID(),
        automationId: AUTOMATION_ID,
        automationRunId: RUN_TWO,
        direction: "outbound",
        sourceRepository: "mauricedesaxe/background-agents",
        fromSha: null,
        toSha: SHA_TWO,
        forkHeadSha: SHA_TWO,
        upstreamHeadSha: FORK_HEAD,
        mergeBaseSha: MERGE_BASE,
        expectedCommitShas: [],
      })
    ).rejects.toThrow(`Exchange cursor changed: expected ${SHA_ONE}`);
  });

  it("does not advance a complete scan after its automation run failed", async () => {
    const store = new UpstreamExchangeStore(env.DB);
    const scanId = crypto.randomUUID();
    await store.beginScan({
      id: scanId,
      automationId: AUTOMATION_ID,
      automationRunId: RUN_ONE,
      direction: "outbound",
      sourceRepository: "MauriceDeSaxe/Background-Agents",
      fromSha: null,
      toSha: SHA_ONE,
      forkHeadSha: SHA_ONE,
      upstreamHeadSha: FORK_HEAD,
      mergeBaseSha: MERGE_BASE,
      expectedCommitShas: [],
    });
    await store.recordSlackDelivery({
      scanId,
      automationId: AUTOMATION_ID,
      automationRunId: RUN_ONE,
      channelId: "C123",
      messageTs: "1.2",
      permalink: "https://slack.test/1",
    });
    await env.DB.prepare(
      "UPDATE automation_runs SET status = 'failed', completed_at = ? WHERE id = ?"
    )
      .bind(Date.now(), RUN_ONE)
      .run();

    expect(await store.finalizeForRun(RUN_ONE)).toMatchObject({
      kind: "blocked",
      reason: "The automation run is no longer active",
    });
    expect(
      await store.getCursor(AUTOMATION_ID, "outbound", "mauricedesaxe/background-agents")
    ).toBeNull();
  });

  it("finishes a failed run's range without recreating durable dispositions", async () => {
    const store = new UpstreamExchangeStore(env.DB);
    const firstScanId = crypto.randomUUID();
    const disposition = {
      classification: "clean_candidate" as const,
      evidence: "Touches shared scheduler code.",
      affectedPackages: ["control-plane"],
      terraformImpact: "none",
      migrationImpact: "none",
      divergenceEntries: [],
      testHandMerge: false,
      semanticPortEvidence: "not present locally",
      usefulUnit: null,
      proposedArtifact: null,
    };
    await store.beginScan({
      id: firstScanId,
      automationId: AUTOMATION_ID,
      automationRunId: RUN_ONE,
      direction: "inbound",
      sourceRepository: "ColeMurray/background-agents",
      fromSha: null,
      toSha: SHA_TWO,
      forkHeadSha: FORK_HEAD,
      upstreamHeadSha: SHA_TWO,
      mergeBaseSha: MERGE_BASE,
      expectedCommitShas: [SHA_ONE, SHA_TWO],
    });
    await store.recordDisposition({
      scanId: firstScanId,
      automationId: AUTOMATION_ID,
      automationRunId: RUN_ONE,
      commitSha: SHA_ONE,
      disposition,
    });
    await env.DB.prepare("UPDATE automation_runs SET status = 'failed' WHERE id = ?")
      .bind(RUN_ONE)
      .run();

    const secondScanId = crypto.randomUUID();
    const resumedRange = await store.beginScan({
      id: secondScanId,
      automationId: AUTOMATION_ID,
      automationRunId: RUN_TWO,
      direction: "inbound",
      sourceRepository: "ColeMurray/background-agents",
      fromSha: null,
      toSha: SHA_TWO,
      forkHeadSha: FORK_HEAD,
      upstreamHeadSha: SHA_TWO,
      mergeBaseSha: MERGE_BASE,
      expectedCommitShas: [SHA_ONE, SHA_TWO],
    });
    expect(resumedRange.classifiedCommitShas).toEqual([SHA_ONE]);
    await store.recordDisposition({
      scanId: secondScanId,
      automationId: AUTOMATION_ID,
      automationRunId: RUN_TWO,
      commitSha: SHA_TWO,
      disposition: { ...disposition, classification: "needs_decision" },
    });
    await store.recordSlackDelivery({
      scanId: secondScanId,
      automationId: AUTOMATION_ID,
      automationRunId: RUN_TWO,
      channelId: "C123",
      messageTs: "2.3",
      permalink: "https://slack.test/2",
    });

    expect(await store.finalizeForRun(RUN_TWO)).toMatchObject({ kind: "finalized" });
    expect(await store.getCursor(AUTOMATION_ID, "inbound", "ColeMurray/background-agents")).toBe(
      SHA_TWO
    );
  });

  it("rejects changed repository heads when resuming the same run", async () => {
    const store = new UpstreamExchangeStore(env.DB);
    const params = {
      id: crypto.randomUUID(),
      automationId: AUTOMATION_ID,
      automationRunId: RUN_ONE,
      direction: "inbound" as const,
      sourceRepository: "ColeMurray/background-agents",
      fromSha: null,
      toSha: SHA_TWO,
      forkHeadSha: FORK_HEAD,
      upstreamHeadSha: SHA_TWO,
      mergeBaseSha: MERGE_BASE,
      expectedCommitShas: [SHA_ONE, SHA_TWO],
    };
    await store.beginScan(params);

    await expect(store.beginScan({ ...params, forkHeadSha: "c".repeat(40) })).rejects.toThrow(
      "This automation run already owns a different exchange scan"
    );
    await expect(store.beginScan({ ...params, mergeBaseSha: "d".repeat(40) })).rejects.toThrow(
      "This automation run already owns a different exchange scan"
    );
  });
});
