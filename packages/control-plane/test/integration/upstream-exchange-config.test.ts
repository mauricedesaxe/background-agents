import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

describe("fork upstream exchange configuration", () => {
  it("installs two enabled daily instances for the tracked fork", async () => {
    const result = await env.DB.prepare(
      `SELECT a.id, a.schedule_cron, a.schedule_tz, a.enabled, a.model,
              a.reasoning_effort, r.repo_owner, r.repo_name, r.repo_id
       FROM automations AS a
       JOIN automation_repositories AS r ON r.automation_id = a.id
       WHERE a.id IN ('fork-upstream-exchange-outbound', 'fork-upstream-exchange-inbound')
       ORDER BY a.id`
    ).all<{
      id: string;
      schedule_cron: string;
      schedule_tz: string;
      enabled: number;
      model: string;
      reasoning_effort: string;
      repo_owner: string;
      repo_name: string;
      repo_id: number;
    }>();

    expect(result.results).toEqual([
      {
        id: "fork-upstream-exchange-inbound",
        schedule_cron: "0 9 * * *",
        schedule_tz: "UTC",
        enabled: 1,
        model: "openai/gpt-5.6-sol",
        reasoning_effort: "high",
        repo_owner: "mauricedesaxe",
        repo_name: "background-agents",
        repo_id: 1297529801,
      },
      {
        id: "fork-upstream-exchange-outbound",
        schedule_cron: "0 8 * * *",
        schedule_tz: "UTC",
        enabled: 1,
        model: "openai/gpt-5.6-sol",
        reasoning_effort: "high",
        repo_owner: "mauricedesaxe",
        repo_name: "background-agents",
        repo_id: 1297529801,
      },
    ]);
  });
});
