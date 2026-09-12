import { describe, expect, it } from "vitest";
import type { ChildSessionDetail } from "@open-inspect/shared/types/session-api";
import { buildChildResultPrompt } from "./child-result-prompt";

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
