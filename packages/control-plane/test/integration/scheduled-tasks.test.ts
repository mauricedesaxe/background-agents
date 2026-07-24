import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { scheduledTaskRoutes } from "../../src/routes/scheduled-tasks";
import type { RequestContext } from "../../src/routes/shared";
import type { Env } from "../../src/types";
import { cleanD1Tables } from "./cleanup";

function route(method: string, path: string) {
  const entry = scheduledTaskRoutes.find(
    (candidate) => candidate.method === method && candidate.pattern.test(path)
  );
  if (!entry) throw new Error(`Missing route ${method} ${path}`);
  return { handler: entry.handler, match: path.match(entry.pattern)! };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>
): Promise<Response> {
  const { handler, match } = route(method, path);
  const url = new URL(`https://test.local${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  const request = new Request(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const ctx = {
    trace_id: "trace-1",
    request_id: "request-1",
    db: env.DB,
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  } as unknown as RequestContext;
  return handler(request, env as Env, match, ctx);
}

function onceAutomation(overrides: Partial<AutomationRow> = {}): AutomationRow {
  const now = Date.now();
  return {
    id: "scheduled-task-1",
    name: "Inspect the deployment",
    instructions: "Inspect the deployment",
    trigger_type: "once",
    schedule_cron: null,
    schedule_tz: "UTC",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    next_run_at: now + 60_000,
    consecutive_failures: 0,
    created_by: "github-user",
    user_id: "usr_owner",
    created_at: now,
    updated_at: now,
    deleted_at: null,
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
    ...overrides,
  };
}

describe("scheduled task routes (D1 integration)", () => {
  beforeEach(cleanD1Tables);

  it("rejects a task whose deadline has passed at the database write", async () => {
    const store = new AutomationStore(env.DB);
    const row = onceAutomation({ next_run_at: Date.now() - 1 });

    expect(await store.insertOnceIfFuture(row, [], [])).toBe(false);
    expect(await store.getById(row.id)).toBeNull();
  });

  it("persists an absolute future instant without creating a session", async () => {
    const executeAt = new Date(Date.now() + 60_000).toISOString();

    const response = await call("POST", "/scheduled-tasks", {
      instructions: "Inspect the deployment",
      executeAt,
      scheduleTz: "Europe/London",
      ownerUserId: "usr_owner",
      participantUserId: "github-user",
    });

    expect(response.status).toBe(201);
    const task = await response.json<{ task: { automation: { nextRunAt: number } } }>();
    expect(task.task.automation.nextRunAt).toBe(Date.parse(executeAt));
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first<{ count: number }>()
    ).toEqual({ count: 0 });
  });

  it.each([
    ["a past instant", new Date(Date.now() - 60_000).toISOString(), "UTC"],
    ["an instant without an offset", "2030-01-02T10:30:00", "UTC"],
    ["a non-ISO instant", "July 25, 2030 10:30:00 Z", "UTC"],
    ["an invalid timezone", new Date(Date.now() + 60_000).toISOString(), "Mars/Olympus"],
  ])("rejects %s", async (_case, executeAt, scheduleTz) => {
    const response = await call("POST", "/scheduled-tasks", {
      instructions: "Inspect the deployment",
      executeAt,
      scheduleTz,
      ownerUserId: "usr_owner",
      participantUserId: "github-user",
    });

    expect(response.status).toBe(400);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM automations").first<{ count: number }>()
    ).toEqual({ count: 0 });
  });

  it("scopes the scheduled list to its canonical owner", async () => {
    const store = new AutomationStore(env.DB);
    await store.create(onceAutomation());
    await store.create(onceAutomation({ id: "other-task", user_id: "other-owner" }));

    const response = await call("GET", "/scheduled-tasks", undefined, {
      ownerUserId: "usr_owner",
    });

    expect(response.status).toBe(200);
    const result = await response.json<{ tasks: Array<{ automation: { id: string } }> }>();
    expect(result.tasks.map((task) => task.automation.id)).toEqual(["scheduled-task-1"]);
  });

  it("returns the current execution when claim beats cancellation", async () => {
    const store = new AutomationStore(env.DB);
    const now = Date.now();
    const automation = onceAutomation({ next_run_at: now - 1_000 });
    await store.create(automation);
    await store.insertInvocationGuarded({
      invocation: {
        id: "invocation-1",
        automation_id: automation.id,
        source: "schedule",
        scheduled_at: automation.next_run_at,
        trigger_key: null,
        concurrency_key: null,
        trigger_metadata: null,
        skip_reason: null,
        failure_counted_at: null,
        created_at: now,
        updated_at: now,
      },
      children: [
        {
          id: "run-1",
          automation_id: automation.id,
          invocation_id: "invocation-1",
          session_id: "session-1",
          status: "running",
          skip_reason: null,
          failure_reason: null,
          scheduled_at: automation.next_run_at!,
          started_at: now,
          completed_at: null,
          created_at: now,
          repo_owner: null,
          repo_name: null,
          repo_id: null,
          base_branch: null,
          environment_id: null,
        },
      ],
      overlapScope: { kind: "automation" },
      consumeOnce: { dueAt: automation.next_run_at!, now },
    });

    const response = await call("POST", `/scheduled-tasks/${automation.id}/cancel`, {
      ownerUserId: "usr_owner",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Scheduled task has already started or was cancelled",
      task: { state: "running", invocation: { id: "invocation-1" } },
    });
  });

  it("rejects multiple session targets", async () => {
    const response = await call("POST", "/scheduled-tasks", {
      instructions: "Inspect the deployment",
      executeAt: new Date(Date.now() + 60_000).toISOString(),
      scheduleTz: "UTC",
      ownerUserId: "usr_owner",
      participantUserId: "github-user",
      repositories: [{ repoOwner: "acme", repoName: "api" }],
      environmentIds: ["env_1"],
    });

    expect(response.status).toBe(400);
  });
});
