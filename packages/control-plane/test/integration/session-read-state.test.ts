import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { SessionIndexStore } from "../../src/db/session-index";
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

    await updateReadState("mark_unread");
    await expectListedUnread(true);
    await updateReadState("mark_read");
    await expectListedUnread(false);

    await env.DB.prepare(
      "UPDATE sessions SET latest_output_message_id = ?, latest_output_at = ? WHERE id = ?"
    )
      .bind("message-1", now, "unread-session")
      .run();

    await expectListedUnread(true);
    await updateReadState("viewed");
    await expectListedUnread(false);

    await updateReadState("mark_unread");
    await updateReadState("viewed");
    await expectListedUnread(true);

    await updateReadState("mark_read");
    await expectListedUnread(false);

    await env.DB.prepare(
      "UPDATE sessions SET latest_output_message_id = ?, latest_output_at = ? WHERE id = ?"
    )
      .bind("message-2", now + 1, "unread-session")
      .run();
    await expectListedUnread(true);
  });
});

async function expectListedUnread(expected: boolean): Promise<void> {
  const response = await serviceFetch("https://test.local/sessions");
  expect(response.status).toBe(200);
  const body = await response.json<{ sessions: Array<{ id: string; unread?: boolean }> }>();
  expect(body.sessions.find((session) => session.id === "unread-session")?.unread).toBe(expected);
}

async function updateReadState(action: "viewed" | "mark_read" | "mark_unread"): Promise<void> {
  const response = await serviceFetch("https://test.local/sessions/unread-session/read-state", {
    method: "PATCH",
    body: JSON.stringify({ action }),
  });
  expect(response.status).toBe(200);
}
