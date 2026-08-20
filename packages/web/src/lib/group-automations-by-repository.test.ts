import { describe, expect, it } from "vitest";
import type { Automation, AutomationRepository } from "@open-inspect/shared/types/automations";
import {
  groupAutomationsByRepository,
  MULTIPLE_REPOSITORIES_GROUP_LABEL,
} from "./group-automations-by-repository";

function repository(repoOwner: string, repoName: string): AutomationRepository {
  return { repoOwner, repoName, repoId: 1, baseBranch: null };
}

function automation(id: string, repositories: AutomationRepository[]): Automation {
  return { id, repositories } as unknown as Automation;
}

describe("groupAutomationsByRepository", () => {
  it("groups single-repo automations under owner/name, sorted alphabetically", () => {
    const groups = groupAutomationsByRepository([
      automation("z", [repository("acme", "web")]),
      automation("a", [repository("acme", "api")]),
      automation("b", [repository("acme", "api")]),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["acme/api", "acme/web"]);
    expect(groups[0].automations.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(groups[1].automations.map((entry) => entry.id)).toEqual(["z"]);
  });

  it("puts multi-repo and repo-less automations in one bucket, last", () => {
    const groups = groupAutomationsByRepository([
      automation("multi", [repository("acme", "api"), repository("acme", "web")]),
      automation("single", [repository("acme", "api")]),
      automation("env-only", []),
    ]);

    expect(groups[0].label).toBe("acme/api");
    const bucket = groups[groups.length - 1];
    expect(bucket.label).toBe(MULTIPLE_REPOSITORIES_GROUP_LABEL);
    expect(bucket.automations.map((entry) => entry.id)).toEqual(["multi", "env-only"]);
  });

  it("omits the bucket when every automation targets exactly one repository", () => {
    const groups = groupAutomationsByRepository([automation("only", [repository("acme", "api")])]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("acme/api");
  });
});
