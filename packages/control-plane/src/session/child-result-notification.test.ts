import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import type { Logger } from "../logger";
import type { AlarmScheduler } from "../platform-ports";
import {
  ChildResultNotifier,
  SqlChildResultNotificationStore,
  type ChildResultNotification,
  type ChildResultNotificationStore,
} from "./child-result-notification";
import { SessionInternalPaths } from "./contracts";
import type { SessionRuntimeClient } from "./runtime-client";
import { initSchema } from "./schema";

type Pending = Parameters<ChildResultNotificationStore["add"]>[0];

class MemoryStore implements ChildResultNotificationStore {
  readonly rows = new Map<string, Pending>();

  add(notification: Pending): void {
    const key = this.key(notification.childSessionId, notification.statusRevision);
    if (!this.rows.has(key)) this.rows.set(key, notification);
  }

  get(childSessionId: string, statusRevision: number): Pending | null {
    return this.rows.get(this.key(childSessionId, statusRevision)) ?? null;
  }

  listDue(now: number, limit: number): Pending[] {
    return [...this.rows.values()]
      .filter((row) => row.nextAttemptAt <= now)
      .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt)
      .slice(0, limit);
  }

  nextAttemptAt(): number | null {
    const deadlines = [...this.rows.values()].map((row) => row.nextAttemptAt);
    return deadlines.length > 0 ? Math.min(...deadlines) : null;
  }

  recordFailure(
    childSessionId: string,
    statusRevision: number,
    attempts: number,
    nextAttemptAt: number
  ): void {
    const row = this.get(childSessionId, statusRevision);
    if (row)
      this.rows.set(this.key(childSessionId, statusRevision), { ...row, attempts, nextAttemptAt });
  }

  remove(childSessionId: string, statusRevision: number): void {
    this.rows.delete(this.key(childSessionId, statusRevision));
  }

  private key(childSessionId: string, statusRevision: number): string {
    return `${childSessionId}:${statusRevision}`;
  }
}

const notification: ChildResultNotification = {
  parentSessionId: "parent-1",
  childSessionId: "child-1",
  status: "completed",
  title: "Child title",
  statusRevision: 2,
  messageId: "message-final",
  authorUserId: "user-1",
  payload: {
    session: { title: "Child title", repoOwner: "acme", repoName: "repo" },
    finalResponse: {
      messageId: "message-final",
      textContent: "Done",
      artifacts: [],
    },
  },
};

function harness() {
  let now = 1_000;
  const store = new MemoryStore();
  const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () =>
    Promise.resolve(new Response(null, { status: 200 }))
  );
  const sessions: SessionRuntimeClient = { fetch };
  const backgroundTasks = createTestBackgroundTasks();
  const schedule = vi.fn(async () => {});
  const alarmScheduler: AlarmScheduler = {
    schedule,
    cancel: vi.fn(async () => {}),
    current: vi.fn(async () => null),
  };
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  const notifier = new ChildResultNotifier(
    store,
    sessions,
    backgroundTasks,
    alarmScheduler,
    log,
    () => now
  );
  return {
    notifier,
    store,
    fetch,
    schedule,
    backgroundTasks,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("ChildResultNotifier", () => {
  it("persists before delivery and removes the row after the parent accepts it", async () => {
    const h = harness();

    h.notifier.enqueue(notification);
    expect(h.store.get("child-1", 2)).toMatchObject(notification);
    await h.backgroundTasks.settle();

    expect(h.store.get("child-1", 2)).toBeNull();
    const [parentId, path, init] = h.fetch.mock.calls[0];
    expect(parentId).toBe("parent-1");
    expect(path).toBe(SessionInternalPaths.childSessionUpdate);
    expect(JSON.parse(String(init?.body))).toEqual({
      childSessionId: "child-1",
      status: "completed",
      statusRevision: 2,
      title: "Child title",
      childResult: {
        messageId: "message-final",
        authorUserId: "user-1",
        payload: notification.payload,
      },
    });
  });

  it("retries a rejected parent update from the shared alarm", async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));

    h.notifier.enqueue(notification);
    await h.backgroundTasks.settle();

    expect(h.store.get("child-1", 2)).toMatchObject({ attempts: 1, nextAttemptAt: 6_000 });
    expect(h.schedule).toHaveBeenCalledWith(6_000);

    h.setNow(6_000);
    await h.notifier.flushPending();

    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.store.get("child-1", 2)).toBeNull();
  });

  it("rearms the earliest persisted delivery after a runtime restart", async () => {
    const h = harness();
    h.store.add({ ...notification, attempts: 3, nextAttemptAt: 9_000 });
    h.store.add({
      ...notification,
      childSessionId: "child-2",
      statusRevision: 4,
      attempts: 1,
      nextAttemptAt: 7_000,
    });

    await h.notifier.rearm();

    expect(h.schedule).toHaveBeenCalledWith(7_000);
  });
});

describe("SqlChildResultNotificationStore", () => {
  it("round-trips pending notifications and preserves retry metadata on duplicate add", () => {
    const db = new DatabaseSync(":memory:");
    const { sql } = createNodeSqlStorage(db);
    initSchema(sql);
    const store = new SqlChildResultNotificationStore(sql);
    const pending = { ...notification, attempts: 2, nextAttemptAt: 9_000 };

    store.add(pending);
    store.add({ ...pending, attempts: 0, nextAttemptAt: 1_000 });

    expect(store.get("child-1", 2)).toEqual(pending);
    expect(store.listDue(8_999, 10)).toEqual([]);
    expect(store.listDue(9_000, 10)).toEqual([pending]);
    expect(store.nextAttemptAt()).toBe(9_000);
    store.remove("child-1", 2);
    expect(store.get("child-1", 2)).toBeNull();
    db.close();
  });

  it("keeps the terminal payload immutable across retries", () => {
    const db = new DatabaseSync(":memory:");
    const { sql } = createNodeSqlStorage(db);
    initSchema(sql);
    const store = new SqlChildResultNotificationStore(sql);
    const pending = { ...structuredClone(notification), attempts: 0, nextAttemptAt: 1_000 };

    store.add(pending);
    pending.payload.finalResponse!.textContent = "mutated after persistence";

    expect(store.get("child-1", 2)?.payload.finalResponse?.textContent).toBe("Done");
    db.close();
  });
});
