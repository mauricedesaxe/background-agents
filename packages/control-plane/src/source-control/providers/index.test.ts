import { describe, expect, it } from "vitest";
import { createSourceControlProvider } from "./index";
import { SourceControlProviderError } from "../errors";

describe("createSourceControlProvider", () => {
  it("throws for gitlab without configuration", () => {
    expect(() => createSourceControlProvider({ provider: "gitlab" })).toThrow(
      SourceControlProviderError
    );
    expect(() => createSourceControlProvider({ provider: "gitlab" })).toThrow(
      "SCM provider 'gitlab' requires gitlab configuration."
    );
  });

  it("throws explicit not-implemented error for bitbucket", () => {
    const createBitbucketProvider = () =>
      createSourceControlProvider({
        provider: "bitbucket",
      });

    expect(createBitbucketProvider).toThrow(SourceControlProviderError);
    expect(createBitbucketProvider).toThrow(
      "SCM provider 'bitbucket' is configured but not implemented."
    );
  });

  it("throws for unknown provider values at runtime", () => {
    expect(() =>
      createSourceControlProvider({
        provider: "unknown" as unknown as "github",
      })
    ).toThrow("Unsupported source control provider: unknown");
  });
});
