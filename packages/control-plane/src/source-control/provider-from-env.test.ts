import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import { SourceControlProviderError } from "./errors";
import { createSourceControlProviderFromEnv } from "./provider-from-env";

function createEnv(overrides?: Partial<Env>): Env {
  return {
    DEPLOYMENT_NAME: "test",
    ...overrides,
  } as Env;
}

describe("createSourceControlProviderFromEnv", () => {
  it("creates a GitLab provider with credential helper auth when configured", async () => {
    const provider = createSourceControlProviderFromEnv(
      createEnv({
        SCM_PROVIDER: "gitlab",
        GITLAB_ACCESS_TOKEN: "glpat-test",
        GITLAB_NAMESPACE: "acme",
      })
    );

    await expect(provider.generateCredentialHelperAuth()).resolves.toMatchObject({
      username: "oauth2",
      password: "glpat-test",
    });
  });

  it("throws the existing provider error when GitLab lacks configuration", () => {
    const createProvider = () =>
      createSourceControlProviderFromEnv(createEnv({ SCM_PROVIDER: "gitlab" }));

    expect(createProvider).toThrow(SourceControlProviderError);
    expect(createProvider).toThrow("SCM provider 'gitlab' requires gitlab configuration.");
  });
});
