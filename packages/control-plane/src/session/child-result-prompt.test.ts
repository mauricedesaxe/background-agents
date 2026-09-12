import { describe, expect, it, vi } from "vitest";
import type { ChildSessionDetail } from "@open-inspect/shared/types/session-api";
import type { SqlResult } from "./sql-storage";
import { buildChildResultPrompt, ChildResultDelivery } from "./child-result-prompt";

function createDetail(overrides: Partial<ChildSessionDetail> = {}): ChildSessionDetail {
  return {
    session: {
      id: "child-1",
      title: "Fix the flaky tests",
      status: "completed",
      repoOwner: "acme",
      repoName: "web-app",
      branchName: "agent/fix-tests",
      model: "anthropic/claude-sonnet-4-6",
      createdAt: 100,
      updatedAt: 200,
    },
    sandbox: null,
    artifacts: [],
    recentEvents: [],
    ...overrides,
  };
}

describe("buildChildResultPrompt", () => {
  it("leads with the child title and status", () => {
    const prompt = buildChildResultPrompt("child-1", createDetail());

    expect(prompt).toBe('Subtask "Fix the flaky tests" finished with status: completed.');
  });

  it("falls back to the child session id when the title is empty", () => {
    const detail = createDetail({
      session: { ...createDetail().session, title: "" },
    });

    expect(buildChildResultPrompt("child-9", detail)).toContain('Subtask "child-9"');
  });

  it("carries the final response text", () => {
    const detail = createDetail({
      finalResponse: {
        textContent: "Fixed the race in the scheduler",
        toolCalls: [],
        artifacts: [],
        mediaArtifacts: [],
        success: true,
        messageId: "msg-1",
        completedAt: 200,
        eventCount: 2,
        eventLimitReached: false,
      },
    });

    const prompt = buildChildResultPrompt("child-1", detail);

    expect(prompt).toContain("Fixed the race in the scheduler");
  });

  it("carries the error cause for a failed child", () => {
    const detail = createDetail({
      session: { ...createDetail().session, status: "failed" },
      finalResponse: {
        textContent: "",
        toolCalls: [],
        artifacts: [],
        mediaArtifacts: [],
        success: false,
        error: "Sandbox timed out",
        messageId: "msg-1",
        completedAt: 200,
        eventCount: 2,
        eventLimitReached: false,
      },
    });

    const prompt = buildChildResultPrompt("child-1", detail);

    expect(prompt).toContain("Error: Sandbox timed out");
  });

  it("lists pull-request artifact links", () => {
    const detail = createDetail({
      artifacts: [
        { type: "pr", url: "https://github.com/acme/web-app/pull/42", metadata: null },
        { type: "screenshot", url: "https://media.example/shot.png", metadata: null },
        { type: "pr", url: "", metadata: null },
      ],
    });

    const prompt = buildChildResultPrompt("child-1", detail);

    expect(prompt).toContain("Pull request: https://github.com/acme/web-app/pull/42");
    expect(prompt).not.toContain("shot.png");
    expect(prompt.match(/Pull request:/g)).toHaveLength(1);
  });
});

function inMemorySql(): {
  exec: (sql: string, ...params: unknown[]) => SqlResult;
  rows: Map<string, { last_seen_status: string; updated_at: number }>;
} {
  const rows = new Map<string, { last_seen_status: string; updated_at: number }>();
  const toArray = () => [];
  const exec = (sql: string, ...params: unknown[]) => {
    if (sql.startsWith("CREATE TABLE")) return { toArray } as unknown as SqlResult;
    if (sql.startsWith("SELECT")) {
      const row = rows.get(params[0] as string);
      return {
        toArray: () => (row ? [{ last_seen_status: row.last_seen_status }] : []),
      } as unknown as SqlResult;
    }
    rows.set(params[0] as string, {
      last_seen_status: params[1] as string,
      updated_at: params[2] as number,
    });
    return { toArray } as unknown as SqlResult;
  };
  return { exec, rows };
}

function createDeliveryDeps(sql: ReturnType<typeof inMemorySql>) {
  return {
    sql,
    fetchChildSummary: vi.fn(async () => Response.json(createDetail())),
    enqueueAgentPrompt: vi.fn(async () => Response.json({ status: "queued" })),
    resolveAuthorUserId: () => "user-1",
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    },
  };
}

const settled = "completed" as const;

describe("ChildResultDelivery", () => {
  it("does not advance the last-seen status when the enqueue throws", async () => {
    const sql = inMemorySql();
    const deps = createDeliveryDeps(sql);
    deps.enqueueAgentPrompt.mockRejectedValueOnce(new Error("socket gone"));
    const delivery = new ChildResultDelivery(deps);

    expect(delivery.shouldDeliverFor("child-1", settled)).toBe(true);
    await delivery.deliver("child-1", settled);

    expect(sql.rows.get("child-1")).toBeUndefined();

    expect(delivery.shouldDeliverFor("child-1", settled)).toBe(true);
  });

  it("does not advance the last-seen status when the enqueue fails", async () => {
    const sql = inMemorySql();
    const deps = createDeliveryDeps(sql);
    deps.enqueueAgentPrompt.mockResolvedValueOnce(
      Response.json({ error: "overloaded" }, { status: 503 })
    );
    const delivery = new ChildResultDelivery(deps);

    expect(delivery.shouldDeliverFor("child-1", settled)).toBe(true);
    await delivery.deliver("child-1", settled);

    expect(sql.rows.get("child-1")).toBeUndefined();
  });

  it("advances the last-seen status after a successful enqueue", async () => {
    const sql = inMemorySql();
    const delivery = new ChildResultDelivery(createDeliveryDeps(sql));

    expect(delivery.shouldDeliverFor("child-1", settled)).toBe(true);
    await delivery.deliver("child-1", settled);

    expect(sql.rows.get("child-1")?.last_seen_status).toBe("completed");
    expect(delivery.shouldDeliverFor("child-1", settled)).toBe(false);
  });

  it("advances the last-seen status on the quiet 409 drop", async () => {
    const sql = inMemorySql();
    const deps = createDeliveryDeps(sql);
    deps.enqueueAgentPrompt.mockResolvedValueOnce(
      Response.json({ error: "not promptable" }, { status: 409 })
    );
    const delivery = new ChildResultDelivery(deps);

    expect(delivery.shouldDeliverFor("child-1", settled)).toBe(true);
    await delivery.deliver("child-1", settled);

    expect(sql.rows.get("child-1")?.last_seen_status).toBe("completed");
    expect(delivery.shouldDeliverFor("child-1", settled)).toBe(false);
  });

  it("records the status immediately when delivery is suppressed", () => {
    const sql = inMemorySql();
    const delivery = new ChildResultDelivery(createDeliveryDeps(sql));

    expect(delivery.shouldDeliverFor("child-1", "active", false)).toBe(false);
    expect(sql.rows.get("child-1")?.last_seen_status).toBe("active");
  });
});
