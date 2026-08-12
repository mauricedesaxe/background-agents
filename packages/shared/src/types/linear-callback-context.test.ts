import { describe, expect, it } from "vitest";
import { linearCallbackContextSchema, linearStartCallbackSchema } from "./session-api";

const transitioningContext = {
  source: "linear",
  issueId: "issue-1",
  issueIdentifier: "ENG-1",
  issueUrl: "https://linear.app/acme/issue/ENG-1",
  model: "anthropic/claude-haiku-4-5",
  organizationId: "org-1",
  appUserId: "app-user-1",
  transitionIssueOnStart: true,
};

const plainContext = {
  source: "linear",
  issueId: "issue-1",
  issueIdentifier: "ENG-1",
  issueUrl: "https://linear.app/acme/issue/ENG-1",
  model: "anthropic/claude-haiku-4-5",
};

describe("linear callback context", () => {
  it("accepts a transitioning context carrying its required organization identity", () => {
    expect(linearCallbackContextSchema.parse(transitioningContext)).toEqual(transitioningContext);
  });

  it("accepts a context carrying neither organization identity nor a transition flag", () => {
    expect(linearCallbackContextSchema.parse(plainContext)).toEqual(plainContext);
  });

  it("rejects a transitioning context missing the identity that arm requires", () => {
    for (const missing of ["organizationId", "appUserId"]) {
      const { [missing]: _dropped, ...context } = transitioningContext;
      expect(linearCallbackContextSchema.safeParse(context).success).toBe(false);
    }
  });

  it("rejects an unexpected key rather than silently dropping it", () => {
    const result = linearCallbackContextSchema.safeParse({
      ...plainContext,
      teamId: "team-1",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unexpected key nested inside a start callback's context", () => {
    const startCallback = {
      sessionId: "session-1",
      messageId: "message-1",
      timestamp: 1_700_000_000_000,
      signature: "signature-1",
      context: plainContext,
    };

    expect(linearStartCallbackSchema.safeParse(startCallback).success).toBe(true);
    expect(
      linearStartCallbackSchema.safeParse({
        ...startCallback,
        context: { ...plainContext, teamId: "team-1" },
      }).success
    ).toBe(false);
  });
});
