import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { createSandboxProviderFromEnv } from "./provider-factory";

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [undefined, 0],
    ["30", 30],
  ])("creates new Daytona sandboxes with auto-stop %s", async (configured, expected) => {
    const fetchSpy = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      Response.json({ id: "daytona-object-1", state: "started" })
    );
    vi.stubGlobal("fetch", fetchSpy);
    const provider = createSandboxProviderFromEnv(
      createEnv({
        DAYTONA_API_URL: "https://daytona.test/api",
        DAYTONA_API_KEY: "daytona-key",
        DAYTONA_BASE_SNAPSHOT: "base",
        DAYTONA_AUTO_STOP_INTERVAL_MINUTES: configured,
      }),
      "daytona"
    );

    await provider.createSandbox({
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      repoOwner: "owner",
      repoName: "repo",
      controlPlaneUrl: "https://control-plane.test",
      sandboxAuthToken: "sandbox-token",
      provider: "openai",
      model: "openai/test-model",
    });

    const request = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({ autoStopInterval: expected });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
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

  it("rejects malformed E2B auto-pause configuration", () => {
    const env = createEnv({
      E2B_API_KEY: "e2b-key",
      E2B_TEMPLATE_ID: "tmpl",
      E2B_AUTO_PAUSE: "tru",
    });

    expect(() => createSandboxProviderFromEnv(env, "e2b")).toThrow(
      "E2B_AUTO_PAUSE must be a valid boolean"
    );
  });

  it("requires an OpenComputer template for starts but not existing-session cleanup", () => {
    const env = createEnv({
      OPENCOMPUTER_API_URL: "https://opencomputer.test",
      OPENCOMPUTER_API_KEY: "opencomputer-key",
    });

    expect(() => createSandboxProviderFromEnv(env, "opencomputer")).toThrow(
      "OPENCOMPUTER_TEMPLATE"
    );
    expect(() =>
      createSandboxProviderFromEnv(env, "opencomputer", {
        requireOpenComputerTemplate: false,
      })
    ).not.toThrow();
  });
});
