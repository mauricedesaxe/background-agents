import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { SessionIndexStore, type SessionReadUpdate } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

describe("session unread state", () => {
  beforeEach(cleanD1Tables);

  it("tracks unseen output and preserves manually unread sessions until explicit read", async () => {
    const now = Date.now();
    const store = new SessionIndexStore(env.DB);
    await env.DB.prepare(
      "INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
      .bind("integration-user", "Integration User", now, now)
      .run();
    await store.create({
      id: "unread-session",
      title: "Unread session",
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: "main",
      status: "completed",
      createdAt: now,
      updatedAt: now,
    });

    await updateReadState({ action: "mark_unread" });
    await expectListedUnread(true);
    await updateReadState({ action: "mark_read" });
    await expectListedUnread(false);

    await env.DB.prepare(
      "UPDATE sessions SET latest_output_message_id = ?, latest_output_at = ? WHERE id = ?"
    )
      .bind("message-1", now, "unread-session")
      .run();

    await expectListedUnread(true);
    await env.DB.prepare(
      "UPDATE sessions SET latest_output_message_id = ?, latest_output_at = ? WHERE id = ?"
    )
      .bind("message-2", now + 1, "unread-session")
      .run();
    await updateReadState({ action: "viewed", messageId: "message-1" });
    await expectListedUnread(true);
    const readState = await env.DB.prepare(
      "SELECT read_output_message_id FROM session_read_states WHERE user_id = ? AND session_id = ?"
    )
      .bind("integration-user", "unread-session")
      .first<{ read_output_message_id: string | null }>();
    expect(readState?.read_output_message_id).toBe("message-1");
    await updateReadState({ action: "viewed", messageId: "message-2" });
    await expectListedUnread(false);

    await updateReadState({ action: "mark_unread" });
    await updateReadState({ action: "viewed", messageId: "message-2" });
    await expectListedUnread(true);

    await updateReadState({ action: "mark_read" });
    await expectListedUnread(false);

    await env.DB.prepare(
      "UPDATE sessions SET latest_output_message_id = ?, latest_output_at = ? WHERE id = ?"
    )
      .bind("message-3", now + 2, "unread-session")
      .run();
    await expectListedUnread(true);
  });

  it("isolates viewed and manual read state between users", async () => {
    const now = Date.now();
    const store = new SessionIndexStore(env.DB);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)"
      ).bind("reader-1", "Reader One", now, now),
      env.DB.prepare(
        "INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)"
      ).bind("reader-2", "Reader Two", now, now),
    ]);
    await store.create({
      id: "shared-session",
      title: "Shared session",
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: "main",
      status: "completed",
      createdAt: now,
      updatedAt: now,
    });
    await store.recordOutput("shared-session", "message-1", now);

    await store.updateReadState("shared-session", "reader-1", {
      action: "viewed",
      messageId: "message-1",
    });
    expect(await listedUnreadFor(store, "reader-1", "shared-session")).toBe(false);
    expect(await listedUnreadFor(store, "reader-2", "shared-session")).toBe(true);

    await store.updateReadState("shared-session", "reader-2", { action: "mark_unread" });
    await store.updateReadState("shared-session", "reader-1", { action: "mark_read" });
    expect(await listedUnreadFor(store, "reader-1", "shared-session")).toBe(false);
    expect(await listedUnreadFor(store, "reader-2", "shared-session")).toBe(true);

    await store.updateReadState("shared-session", "reader-2", { action: "mark_read" });
    await store.updateReadState("shared-session", "reader-1", { action: "mark_unread" });
    expect(await listedUnreadFor(store, "reader-1", "shared-session")).toBe(true);
    expect(await listedUnreadFor(store, "reader-2", "shared-session")).toBe(false);
  });
});

async function listedUnreadFor(
  store: SessionIndexStore,
  userId: string,
  sessionId: string
): Promise<boolean | undefined> {
  const result = await store.list({ viewerUserId: userId });
  return result.sessions.find((session) => session.id === sessionId)?.unread;
}

async function expectListedUnread(expected: boolean): Promise<void> {
  const response = await serviceFetch("https://test.local/sessions");
  expect(response.status).toBe(200);
  const body = await response.json<{ sessions: Array<{ id: string; unread?: boolean }> }>();
  expect(body.sessions.find((session) => session.id === "unread-session")?.unread).toBe(expected);
}

async function updateReadState(update: SessionReadUpdate): Promise<void> {
  const response = await serviceFetch("https://test.local/sessions/unread-session/read-state", {
    method: "PATCH",
    body: JSON.stringify(update),
  });
  expect(response.status).toBe(200);
}
