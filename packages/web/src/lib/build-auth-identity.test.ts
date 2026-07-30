import { describe, expect, it } from "vitest";
import {
  buildAuthDisplay,
  buildAuthIdentity,
  isAuthProvider,
  resolveAuthProvider,
  type AuthIdentityUser,
} from "./build-auth-identity";

const githubUser: AuthIdentityUser = {
  id: "12345",
  login: "ada",
  name: "Ada Lovelace",
  email: "ada@example.com",
  image: "https://avatars.githubusercontent.com/u/12345",
  provider: "github",
};

const googleUser: AuthIdentityUser = {
  id: "google-sub-1",
  name: "Pat PM",
  email: "pm@gmail.com",
  image: "https://lh3.googleusercontent.com/a/pat",
  provider: "google",
};

describe("resolveAuthProvider", () => {
  it("returns the explicit provider", () => {
    expect(resolveAuthProvider(githubUser)).toBe("github");
    expect(resolveAuthProvider(googleUser)).toBe("google");
  });

  it("defaults a missing provider to github (legacy session back-compat)", () => {
    expect(resolveAuthProvider({ id: "12345" })).toBe("github");
    expect(resolveAuthProvider(null)).toBe("github");
    expect(resolveAuthProvider(undefined)).toBe("github");
  });
});

describe("isAuthProvider", () => {
  it("accepts supported providers", () => {
    expect(isAuthProvider("github")).toBe(true);
    expect(isAuthProvider("google")).toBe(true);
  });

  it("rejects unknown or missing providers", () => {
    expect(isAuthProvider("gitlab")).toBe(false);
    expect(isAuthProvider("")).toBe(false);
    expect(isAuthProvider(undefined)).toBe(false);
    expect(isAuthProvider(null)).toBe(false);
  });
});

describe("buildAuthIdentity", () => {
  it("maps a GitHub user to the auth* block", () => {
    expect(buildAuthIdentity(githubUser)).toEqual({
      authProvider: "github",
      authUserId: "12345",
    });
  });

  it("maps a Google user to the auth* block", () => {
    expect(buildAuthIdentity(googleUser)).toEqual({
      authProvider: "google",
      authUserId: "google-sub-1",
    });
  });

  it("defaults the provider", () => {
    expect(buildAuthIdentity({ id: "12345", name: null, email: null, image: null })).toEqual({
      authProvider: "github",
      authUserId: "12345",
    });
  });
});

describe("buildAuthDisplay", () => {
  it("returns display fields only — never authProvider/authUserId (forbidden under strict)", () => {
    expect(buildAuthDisplay(githubUser)).toEqual({
      authEmail: "ada@example.com",
      authName: "Ada Lovelace",
      authAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
    });
    expect(buildAuthDisplay(googleUser)).toEqual({
      authEmail: "pm@gmail.com",
      authName: "Pat PM",
      authAvatarUrl: "https://lh3.googleusercontent.com/a/pat",
    });
  });

  it("normalizes null fields to undefined", () => {
    expect(buildAuthDisplay({ id: "12345", name: null, email: null, image: null })).toEqual({
      authEmail: undefined,
      authName: undefined,
      authAvatarUrl: undefined,
    });
  });
});
