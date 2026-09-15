import { describe, expect, it } from "vitest";
import type { AutomationListItem } from "@open-inspect/shared/types/automations";
import {
  MULTIPLE_REPOSITORIES_GROUP_LABEL,
  groupAutomationsByRepository,
} from "./group-automations-by-repository";

function makeAutomation(
  id: string,
  repositories: Array<{ repoOwner: string; repoName: string }>
): AutomationListItem {
  return {
    id,
    name: `Automation ${id}`,
    instructions: "Do the thing.",
    harness: "opencode",
    triggerType: "schedule",
    scheduleCron: "0 9 * * *",
    scheduleTz: "UTC",
    model: "openai/gpt-5.4",
    reasoningEffort: null,
    enabled: true,
    nextRunAt: null,
    consecutiveFailures: 0,
    createdBy: "user-1",
    userId: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    eventType: null,
    triggerConfig: null,
    repositories: repositories.map((repository, index) => ({
      ...repository,
      repoId: index + 1,
      baseBranch: "main",
    })),
    environmentIds: [],
    providerSelections: {},
    recentExecutions: [],
  };
}

const acmeWeb = { repoOwner: "acme", repoName: "web-app" };
const acmeApi = { repoOwner: "acme", repoName: "api" };
const zetaCli = { repoOwner: "zeta", repoName: "cli" };

describe("groupAutomationsByRepository", () => {
  it("groups single-repository automations under alphabetically sorted owner/name keys", () => {
    const groups = groupAutomationsByRepository([
      makeAutomation("a", [zetaCli]),
      makeAutomation("b", [acmeWeb]),
      makeAutomation("c", [acmeApi]),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["acme/api", "acme/web-app", "zeta/cli"]);
    expect(groups.map((group) => group.automations.map((a) => a.id))).toEqual([
      ["c"],
      ["b"],
      ["a"],
    ]);
  });

  it("lands multi-repository and repository-less automations in one shared bucket sorted last", () => {
    const multi = makeAutomation("multi", [acmeWeb, acmeApi]);
    const repoLess = makeAutomation("repo-less", []);
    const single = makeAutomation("single", [acmeWeb]);

    const groups = groupAutomationsByRepository([multi, single, repoLess]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ label: "acme/web-app", automations: [single] });
    expect(groups[1]!.label).toBe(MULTIPLE_REPOSITORIES_GROUP_LABEL);
    expect(groups[1]!.automations.map((automation) => automation.id)).toEqual([
      "multi",
      "repo-less",
    ]);
  });

  it("omits the shared bucket when every automation targets exactly one repository", () => {
    const groups = groupAutomationsByRepository([
      makeAutomation("a", [acmeWeb]),
      makeAutomation("b", [zetaCli]),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["acme/web-app", "zeta/cli"]);
  });

  it("preserves input order within each group", () => {
    const groups = groupAutomationsByRepository([
      makeAutomation("first", [acmeWeb]),
      makeAutomation("second", [acmeApi]),
      makeAutomation("third", [acmeWeb]),
      makeAutomation("fourth", [acmeApi]),
    ]);

    const acmeWebGroup = groups.find((group) => group.label === "acme/web-app");
    const acmeApiGroup = groups.find((group) => group.label === "acme/api");
    expect(acmeWebGroup!.automations.map((automation) => automation.id)).toEqual([
      "first",
      "third",
    ]);
    expect(acmeApiGroup!.automations.map((automation) => automation.id)).toEqual([
      "second",
      "fourth",
    ]);
  });
});
