import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase, SqlResult, SqlStatement } from "../db/sql-database";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import { handleCancelChild } from "./session-children";
import type { SessionRouteContext } from "./session-route";
import { parsePattern } from "./shared";

describe("handleCancelChild", () => {
  it("attempts every descendant when direct cancellation fails and reports all failures", async () => {
    const db = createDb(["deep-failure", "later-success", "shallow-failure"]);

    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async (sessionId) => {
      if (sessionId === "child" || sessionId === "shallow-failure") {
        throw new Error("transport failure");
      }
      if (sessionId === "deep-failure") {
        return Response.json({ error: "failure" }, { status: 500 });
      }
      return Response.json({ status: "cancelled" });
    });
    const match = "/sessions/parent/children/child/cancel".match(
      parsePattern("/sessions/:id/children/:childId/cancel")
    );
    if (!match) throw new Error("Expected route match");

    const response = await handleCancelChild(
      new Request("https://test.local/sessions/parent/children/child/cancel", { method: "POST" }),
      {} as Env,
      match,
      {
        db,
        metrics: {} as SessionRouteContext["metrics"],
        request_id: "request-id",
        trace_id: "trace-id",
        sessionRuntime: { fetch },
      }
    );

    expect(fetch.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      "child",
      "deep-failure",
      "later-success",
      "shallow-failure",
    ]);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Tasks could not be cancelled: child, deep-failure, shallow-failure",
      cancelledDescendantIds: ["later-success"],
    });
  });
});

function createDb(descendantIds: string[]): SqlDatabase {
  return {
    prepare(query) {
      let boundValues: unknown[] = [];
      const statement: SqlStatement = {
        bind(...values) {
          boundValues = values;
          return statement;
        },
        async first<T>() {
          if (query.includes("SELECT 1 FROM sessions")) return { 1: 1 } as T;
          throw new Error(`Unexpected first() query: ${query}`);
        },
        async all<T>() {
          if (query.includes("WITH RECURSIVE descendants")) {
            return result(descendantIds.map((id) => ({ id })) as T[]);
          }
          throw new Error(`Unexpected all() query: ${query} (${boundValues.join(", ")})`);
        },
        async run() {
          throw new Error(`Unexpected run() query: ${query}`);
        },
      };
      return statement;
    },
    async batch<T>() {
      return [] as SqlResult<T>[];
    },
  };
}

function result<T>(results: T[]): SqlResult<T> {
  return { results, meta: { changes: 0 } };
}
