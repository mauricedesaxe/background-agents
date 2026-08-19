import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { cleanD1Tables } from "./cleanup";
import { fetchRuns } from "./run-helpers";

function getSchedulerStub() {
  const id = env.SCHEDULER.idFromName("global-scheduler");
  return env.SCHEDULER.get(id);
}

function makeOnceRow(overrides?: Partial<AutomationRow>): AutomationRow {
  const now = Date.now();
  return {
    id: `once-${Math.random().toString(36).slice(2, 8)}`,
    name: "Run the smoke tests",
    instructions: "Run the smoke tests",
    trigger_type: "once",
    schedule_cron: null,
    schedule_tz: "UTC",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    next_run_at: now + 60_000,
    consecutive_failures: 0,
    created_by: "user-1",
    user_id: "user-1",
    created_at: now,
    updated_at: now,
    deleted_at: null,
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
    ...overrides,
  };
}

describe("one-shot scheduled tasks", () => {
  beforeEach(cleanD1Tables);

  it("fires a due one-shot exactly once and disables it, no double-launch on redelivery", async () => {
    const store = new AutomationStore(env.DB);
    const now = Date.now();
    await store.insertOnceIfFuture(
      makeOnceRow({ id: "once-fire", next_run_at: now + 60_000 }),
      [],
      []
    );
    await env.DB.prepare("UPDATE automations SET next_run_at = ? WHERE id = ?")
      .bind(now - 60_000, "once-fire") // slot in the past so the tick treats it as overdue
      .run();

    const stub = getSchedulerStub();
    await stub.fetch("http://internal/internal/tick", { method: "POST" });

    const afterFirstTick = await fetchRuns("once-fire");
    expect(afterFirstTick).toHaveLength(1);
    expect(afterFirstTick[0]!.invocation_id).not.toBeNull();

    const disabled = await store.getById("once-fire");
    expect(disabled!.enabled).toBe(0);
    expect(disabled!.next_run_at).toBeNull();

    await stub.fetch("http://internal/internal/tick", { method: "POST" }); // redelivery

    const afterSecondTick = await fetchRuns("once-fire");
    expect(afterSecondTick).toHaveLength(1);
  });

  it("records the firing as a single invocation the task view can read back", async () => {
    const store = new AutomationStore(env.DB);
    const now = Date.now();
    await store.create(makeOnceRow({ id: "once-view", next_run_at: now - 60_000 }));

    const stub = getSchedulerStub();
    await stub.fetch("http://internal/internal/tick", { method: "POST" });

    const { invocations, total } = await store.listInvocations("once-view", {
      limit: 10,
      offset: 0,
    });
    expect(total).toBe(1);
    expect(invocations[0]!.source).toBe("schedule");
    expect(invocations[0]!.runs).toHaveLength(1);
  });

  it("insertOnceIfFuture rejects a task whose executeAt is already in the past", async () => {
    const store = new AutomationStore(env.DB);
    const now = Date.now();
    const persisted = await store.insertOnceIfFuture(
      makeOnceRow({ id: "once-past", next_run_at: now - 1_000 }),
      [],
      []
    );
    expect(persisted).toBe(false);
    expect(await store.getById("once-past")).toBeNull();
  });

  it("cancelOnce disables a task before it fires but refuses once it has an invocation", async () => {
    const store = new AutomationStore(env.DB);
    const now = Date.now();

    await store.insertOnceIfFuture(
      makeOnceRow({ id: "once-cancel", next_run_at: now + 3_600_000 }),
      [],
      []
    );
    expect(await store.cancelOnce("once-cancel", "user-1")).toBe(true);
    const cancelled = await store.getById("once-cancel");
    expect(cancelled!.enabled).toBe(0);
    expect(cancelled!.next_run_at).toBeNull();

    await store.create(makeOnceRow({ id: "once-fired", next_run_at: now - 60_000 }));
    const stub = getSchedulerStub();
    await stub.fetch("http://internal/internal/tick", { method: "POST" });
    expect(await store.cancelOnce("once-fired", "user-1")).toBe(false);
  });
});
