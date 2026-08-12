import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";

const mockStore = {
  getSummary: vi.fn(),
  getTimeseries: vi.fn(),
  getBreakdown: vi.fn(),
};

vi.mock("./db/analytics-store", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AnalyticsStore: vi.fn().mockImplementation(function () {
      return mockStore;
    }),
  };
});

describe("analytics router integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves analytics routes even when the SCM provider is not github", async () => {
    mockStore.getSummary.mockResolvedValue({
      totalSessions: 1,
      activeUsers: 1,
      totalCost: 0,
      avgCost: 0,
      totalPrs: 0,
      statusBreakdown: {
        created: 1,
        active: 0,
        completed: 0,
        failed: 0,
        archived: 0,
        cancelled: 0,
      },
    });

    const tokenRow = {
      id: "token-1",
      token_hash: "hash",
      kind: "web_session",
      user_id: "user-1",
      provider: "github",
      provider_user_id: "583231",
      family_id: "family-1",
      rotated_to: null,
      refresh_winner_encrypted: null,
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
      family_expires_at: null,
      revoked_at: null,
      last_used_at: null,
    };
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => tokenRow),
      all: vi.fn(async () => ({ results: [], meta: { changes: 0 } })),
      run: vi.fn(async () => ({ results: [], meta: { changes: 0 } })),
    };
    const env = {
      SCM_PROVIDER: "gitlab",
      DB: {
        prepare: vi.fn(() => statement),
        batch: vi.fn(async () => []),
        exec: vi.fn(),
        dump: vi.fn(),
      },
    };

    const response = await handleRequest(
      new Request("https://test.local/analytics/summary", {
        headers: { Authorization: "Bearer oi_at_test" },
      }),
      env as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      totalSessions: 1,
      activeUsers: 1,
      totalCost: 0,
      avgCost: 0,
      totalPrs: 0,
      statusBreakdown: {
        created: 1,
        active: 0,
        completed: 0,
        failed: 0,
        archived: 0,
        cancelled: 0,
      },
    });
  });
});
