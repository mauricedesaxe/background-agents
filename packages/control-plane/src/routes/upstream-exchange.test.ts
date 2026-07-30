import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpstreamExchangeConflictError } from "../db/upstream-exchange-store";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import type { RequestContext } from "./shared";
import { upstreamExchangeRoutes } from "./upstream-exchange";

const sessionStoreMock = { get: vi.fn() };
const exchangeStoreMock = { getCursor: vi.fn() };

vi.mock("../db/session-index", () => ({
  SessionIndexStore: vi.fn().mockImplementation(function () {
    return sessionStoreMock;
  }),
}));

vi.mock("../db/upstream-exchange-store", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    UpstreamExchangeStore: vi.fn().mockImplementation(function () {
      return exchangeStoreMock;
    }),
  };
});

const PATH = "/sessions/session-1/upstream-exchange";

function createContext(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "request-1",
    db: {} as SqlDatabase,
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

async function callCursor(): Promise<Response> {
  const route = upstreamExchangeRoutes[0];
  const match = PATH.match(route.pattern)!;
  return route.handler(
    new Request(`https://test.local${PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "cursor",
        direction: "inbound",
        sourceRepository: "ColeMurray/background-agents",
      }),
    }),
    {} as Env,
    match,
    createContext()
  );
}

describe("upstream exchange route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStoreMock.get.mockResolvedValue({
      id: "session-1",
      spawnSource: "automation",
      automationId: "automation-1",
      automationRunId: "run-1",
    });
  });

  it("reports expected ledger conflicts as 409", async () => {
    exchangeStoreMock.getCursor.mockRejectedValue(
      new UpstreamExchangeConflictError("Exchange cursor changed")
    );

    const response = await callCursor();

    expect(response.status).toBe(409);
  });

  it("propagates database failures for the router to report as 500", async () => {
    exchangeStoreMock.getCursor.mockRejectedValue(new Error("D1 unavailable"));

    await expect(callCursor()).rejects.toThrow("D1 unavailable");
  });
});
