import { describe, expect, it } from "vitest";
import {
  buildOnceAutomationRequest,
  deriveOnceAutomationName,
  validateOnceScheduleForm,
} from "./once-schedule";

const NOW = Date.parse("2026-09-11T12:00:00Z");
const FUTURE = NOW + 5 * 60 * 1000;

describe("validateOnceScheduleForm", () => {
  it("accepts a non-empty prompt with a future fire time", () => {
    expect(
      validateOnceScheduleForm({ instructions: "Run the nightly sweep", onceRunAt: FUTURE }, NOW)
    ).toBeNull();
  });

  it("rejects a blank prompt", () => {
    expect(validateOnceScheduleForm({ instructions: "   ", onceRunAt: FUTURE }, NOW)).toBe(
      "Enter a prompt to schedule."
    );
  });

  it("rejects a missing fire time", () => {
    expect(validateOnceScheduleForm({ instructions: "Do it", onceRunAt: null }, NOW)).toBe(
      "Choose when to run this."
    );
  });

  it("rejects a fire time in the past or exactly now", () => {
    expect(validateOnceScheduleForm({ instructions: "Do it", onceRunAt: NOW - 1 }, NOW)).toBe(
      "Choose a time in the future."
    );
    expect(validateOnceScheduleForm({ instructions: "Do it", onceRunAt: NOW }, NOW)).toBe(
      "Choose a time in the future."
    );
  });
});

describe("buildOnceAutomationRequest", () => {
  it("carries the prompt, fire time, and once trigger with no target", () => {
    expect(buildOnceAutomationRequest("  Do it  ", FUTURE, null)).toEqual({
      name: "Do it",
      instructions: "Do it",
      triggerType: "once",
      onceRunAt: FUTURE,
    });
  });

  it("maps the scalar repository target onto repositories", () => {
    const request = buildOnceAutomationRequest("Do it", FUTURE, {
      repoOwner: "acme",
      repoName: "api",
    });
    expect(request.repositories).toEqual([{ repoOwner: "acme", repoName: "api" }]);
    expect(request.environmentIds).toBeUndefined();
  });

  it("maps the multi-repository target onto repositories", () => {
    const request = buildOnceAutomationRequest("Do it", FUTURE, {
      repositories: [
        { repoOwner: "acme", repoName: "api" },
        { repoOwner: "acme", repoName: "web-app" },
      ],
    });
    expect(request.repositories).toEqual([
      { repoOwner: "acme", repoName: "api" },
      { repoOwner: "acme", repoName: "web-app" },
    ]);
  });

  it("maps the environment target onto environmentIds", () => {
    const request = buildOnceAutomationRequest("Do it", FUTURE, {
      environmentId: "env_1",
    });
    expect(request.environmentIds).toEqual(["env_1"]);
    expect(request.repositories).toBeUndefined();
  });
});

describe("deriveOnceAutomationName", () => {
  it("uses the first line of the prompt", () => {
    expect(deriveOnceAutomationName("First line\nsecond line")).toBe("First line");
  });

  it("caps long prompts and falls back when blank", () => {
    expect(deriveOnceAutomationName("x".repeat(120))).toHaveLength(80);
    expect(deriveOnceAutomationName("   ")).toBe("Scheduled run");
  });
});
