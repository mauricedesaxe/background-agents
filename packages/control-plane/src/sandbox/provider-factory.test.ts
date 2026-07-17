import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { createSandboxProviderFromEnv } from "./provider-factory";
import { createDaytonaRestClient } from "./daytona-rest-client";
import type * as DaytonaRestClientModule from "./daytona-rest-client";

vi.mock("./daytona-rest-client", async (importOriginal) => {
  const actual = await importOriginal<typeof DaytonaRestClientModule>();
  return { ...actual, createDaytonaRestClient: vi.fn(actual.createDaytonaRestClient) };
});

function createEnv(overrides: Partial<Env>): Env {
  return {
    DB: {} as D1Database,
    SESSION: {} as DurableObjectNamespace,
    MEDIA_BUCKET: {} as R2Bucket,
    TOKEN_ENCRYPTION_KEY: "test-token-key",
    DEPLOYMENT_NAME: "test",
    ...overrides,
  } as Env;
}

describe("createSandboxProviderFromEnv", () => {
  it("rejects malformed Vercel numeric configuration", () => {
    const env = createEnv({
      VERCEL_TOKEN: "vercel-token",
      VERCEL_PROJECT_ID: "project-id",
      VERCEL_SNAPSHOT_EXPIRATION_MS: "10m",
    });

    expect(() => createSandboxProviderFromEnv(env, "vercel")).toThrow(
      "VERCEL_SNAPSHOT_EXPIRATION_MS must be a valid number"
    );
  });

  it("rejects malformed Daytona auto-stop configuration", () => {
    const env = createEnv({
      DAYTONA_API_URL: "https://daytona.test",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_BASE_SNAPSHOT: "base",
      DAYTONA_AUTO_STOP_INTERVAL_MINUTES: "abc",
    });

    expect(() => createSandboxProviderFromEnv(env, "daytona")).toThrow(
      "DAYTONA_AUTO_STOP_INTERVAL_MINUTES must be a valid number"
    );
  });

  it("rejects malformed Daytona auto-archive configuration", () => {
    const env = createEnv({
      DAYTONA_API_URL: "https://daytona.test",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_BASE_SNAPSHOT: "base",
      DAYTONA_AUTO_STOP_INTERVAL_MINUTES: "30",
      DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES: "abc",
    });

    expect(() => createSandboxProviderFromEnv(env, "daytona")).toThrow(
      "DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES must be a valid number"
    );
  });

  it("defaults the Daytona auto-archive interval to 1440 minutes when unset", () => {
    const env = createEnv({
      DAYTONA_API_URL: "https://daytona.test",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_BASE_SNAPSHOT: "base",
    });

    createSandboxProviderFromEnv(env, "daytona");

    expect(vi.mocked(createDaytonaRestClient)).toHaveBeenCalledWith(
      expect.objectContaining({ autoArchiveIntervalMinutes: 1440 })
    );
  });
});
