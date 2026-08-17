import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  linearAgentActivityResponseSchema,
  linearAgentSessionUpdateResponseSchema,
  linearCommentCreateResponseSchema,
  linearIssueDetailsResponseSchema,
  linearRepoSuggestionsResponseSchema,
  linearUserResponseSchema,
} from "./types";

const issue = {
  id: "issue-1",
  identifier: "ENG-1",
  title: "Fix bug",
  description: null,
  url: "https://linear.app/acme/issue/ENG-1",
  priority: 2,
  priorityLabel: "High",
  labels: { nodes: [{ id: "label-1", name: "bug" }] },
  project: null,
  assignee: null,
  team: { id: "team-1", key: "ENG", name: "Engineering" },
  comments: { nodes: [{ body: "please fix", user: null }] },
};

const fixtures: Array<{
  operation: string;
  schema: z.ZodType;
  valid: unknown;
  malformed: unknown;
}> = [
  {
    operation: "AgentActivityCreate",
    schema: linearAgentActivityResponseSchema,
    valid: { data: { agentActivityCreate: { success: true } } },
    malformed: { data: { agentActivityCreate: {} } },
  },
  {
    operation: "IssueDetails",
    schema: linearIssueDetailsResponseSchema,
    valid: { data: { issue } },
    malformed: { data: { issue: { id: "issue-1", title: "missing required fields" } } },
  },
  {
    operation: "AgentSessionUpdate",
    schema: linearAgentSessionUpdateResponseSchema,
    valid: { data: { agentSessionUpdate: { success: true } } },
    malformed: { data: { agentSessionUpdate: null } },
  },
  {
    operation: "RepoSuggestions",
    schema: linearRepoSuggestionsResponseSchema,
    valid: {
      data: {
        issueRepositorySuggestions: {
          suggestions: [{ repositoryFullName: "acme/api", confidence: 0.92 }],
        },
      },
    },
    malformed: {
      data: { issueRepositorySuggestions: { suggestions: [{ repositoryFullName: "acme/api" }] } },
    },
  },
  {
    operation: "FetchUser",
    schema: linearUserResponseSchema,
    valid: { data: { user: { id: "user-1", name: "Alice", email: null } } },
    malformed: { data: { user: { id: "user-1", email: "alice@example.com" } } },
  },
  {
    operation: "CommentCreate",
    schema: linearCommentCreateResponseSchema,
    valid: { data: { commentCreate: { success: true } } },
    malformed: { data: { commentCreate: { success: "yes" } } },
  },
];

describe.each(fixtures)("$operation response schema", ({ schema, valid, malformed }) => {
  it("parses a valid response fixture", () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it("rejects a malformed response fixture", () => {
    expect(schema.safeParse(malformed).success).toBe(false);
  });
});

describe("IssueDetails response schema", () => {
  it("normalizes nullable response collections", () => {
    const result = linearIssueDetailsResponseSchema.parse({ data: { issue } });

    expect(result.data?.issue?.labels).toEqual([{ id: "label-1", name: "bug" }]);
    expect(result.data?.issue?.comments).toEqual([{ body: "please fix", user: null }]);
  });
});
