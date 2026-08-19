import { describe, expect, it } from "vitest";
import type { ChildSessionDetail } from "@open-inspect/shared/types/session-api";
import { buildChildResultPrompt } from "./child-result-prompt";

function createDetail(overrides: Partial<ChildSessionDetail> = {}): ChildSessionDetail {
  return {
    session: {
      id: "child-1",
      title: "Investigate flaky test",
      status: "completed",
      repoOwner: "acme",
      repoName: "repo",
      branchName: "feature/child",
      model: "anthropic/claude-haiku-4-5",
      createdAt: 1000,
      updatedAt: 2000,
    },
    sandbox: { status: "stopped" },
    artifacts: [],
    recentEvents: [],
    ...overrides,
  };
}

describe("buildChildResultPrompt", () => {
  it("includes the child title, status, and final response text", () => {
    const prompt = buildChildResultPrompt(
      "child-1",
      createDetail({
        finalResponse: {
          textContent: "Fixed the flake by seeding the clock.",
          toolCalls: [],
          artifacts: [],
          mediaArtifacts: [],
          success: true,
          messageId: "msg-1",
          completedAt: 2000,
          eventCount: 3,
          eventLimitReached: false,
        },
      })
    );

    expect(prompt).toBe(
      [
        'Subtask "Investigate flaky test" finished with status: completed.',
        "",
        "Fixed the flake by seeding the clock.",
      ].join("\n")
    );
  });

  it("falls back to the child session id when the title is empty", () => {
    const prompt = buildChildResultPrompt(
      "child-42",
      createDetail({
        session: {
          id: "child-42",
          title: "",
          status: "failed",
          repoOwner: null,
          repoName: null,
          branchName: null,
          model: "anthropic/claude-haiku-4-5",
          createdAt: 1000,
          updatedAt: 2000,
        },
        finalResponse: {
          textContent: "",
          toolCalls: [],
          artifacts: [],
          mediaArtifacts: [],
          success: false,
          error: "Sandbox stopped responding",
          messageId: "msg-2",
          completedAt: 2000,
          eventCount: 1,
          eventLimitReached: false,
        },
      })
    );

    expect(prompt).toContain('Subtask "child-42" finished with status: failed.');
    expect(prompt).toContain("Error: Sandbox stopped responding");
  });

  it("appends pull request urls from child artifacts", () => {
    const prompt = buildChildResultPrompt(
      "child-1",
      createDetail({
        artifacts: [
          { type: "pr", url: "https://github.com/acme/repo/pull/12", metadata: null },
          { type: "screenshot", url: "https://example.com/shot.png", metadata: null },
        ],
        finalResponse: {
          textContent: "Opened a PR.",
          toolCalls: [],
          artifacts: [],
          mediaArtifacts: [],
          success: true,
          messageId: "msg-3",
          completedAt: 2000,
          eventCount: 2,
          eventLimitReached: false,
        },
      })
    );

    expect(prompt).toContain("Pull request: https://github.com/acme/repo/pull/12");
    expect(prompt).not.toContain("screenshot");
  });
});
