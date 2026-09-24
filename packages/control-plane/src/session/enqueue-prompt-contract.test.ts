import { describe, expect, it } from "vitest";
import { enqueuePromptRequestSchema } from "./enqueue-prompt-contract";

describe("enqueuePromptRequestSchema", () => {
  it("parses valid enqueue prompt request bodies", () => {
    const body = {
      content: "hello",
      authorId: "github:123",
      source: "github",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: "high",
      attachments: [{ attachmentId: "attachment-1", name: "screenshot.png" }],
      callbackContext: { source: "automation", runId: "run-1" },
      scmEnrichment: {
        userId: "user-1",
        login: "octocat",
        name: null,
        email: null,
      },
    };

    const result = enqueuePromptRequestSchema.safeParse(body);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.content).toBe("hello");
  });

  it("does not expose the internal idempotency key through the HTTP contract", () => {
    const result = enqueuePromptRequestSchema.safeParse({
      content: "hello",
      authorId: "user-1",
      source: "web",
      clientRequestId: "child-result-forged",
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty("clientRequestId");
  });

  it("rejects malformed enqueue prompt request bodies", () => {
    const result = enqueuePromptRequestSchema.safeParse({
      content: "hello",
      authorId: "user-1",
    });

    expect(result.success).toBe(false);
  });

  it("rejects unsupported prompt sources", () => {
    const result = enqueuePromptRequestSchema.safeParse({
      content: "hello",
      authorId: "user-1",
      source: "unknown",
    });

    expect(result.success).toBe(false);
  });
});
