import { describe, expect, it } from "vitest";
import { MAX_SESSION_REPOSITORIES } from "./repositories";
import {
  GIT_SYNC_DIAGNOSTIC_MAX_CHARS,
  GIT_SYNC_REPORT_MAX_BYTES,
  gitSyncReportSchema,
  sandboxErrorRequestSchema,
} from "./sandbox-events";

const failedRepository = {
  repoOwner: "acme",
  repoName: "app",
  operation: "clone" as const,
  status: "failed" as const,
  diagnostic: "repository not found",
  exitCode: 128,
};

describe("gitSyncReportSchema", () => {
  it("accepts the Python producer shape including exitCode", () => {
    expect(
      gitSyncReportSchema.parse({ status: "failed", repositories: [failedRepository] })
    ).toEqual({ status: "failed", repositories: [failedRepository] });
  });

  it("bounds each diagnostic and the repository count", () => {
    expect(
      gitSyncReportSchema.safeParse({
        status: "failed",
        repositories: [
          { ...failedRepository, diagnostic: "x".repeat(GIT_SYNC_DIAGNOSTIC_MAX_CHARS + 1) },
        ],
      }).success
    ).toBe(false);
    expect(
      gitSyncReportSchema.safeParse({
        status: "failed",
        repositories: Array.from({ length: MAX_SESSION_REPOSITORIES + 1 }, () => failedRepository),
      }).success
    ).toBe(false);
  });

  it("rejects a report over the total byte budget", () => {
    const repositories = Array.from({ length: MAX_SESSION_REPOSITORIES }, (_, index) => ({
      ...failedRepository,
      repoOwner: `group-${index}/${"o".repeat(290)}`,
      repoName: "n".repeat(200),
      diagnostic: "d".repeat(GIT_SYNC_DIAGNOSTIC_MAX_CHARS),
    }));
    const report = { status: "failed" as const, repositories };

    expect(new TextEncoder().encode(JSON.stringify(report)).byteLength).toBeGreaterThan(
      GIT_SYNC_REPORT_MAX_BYTES
    );
    expect(gitSyncReportSchema.safeParse(report).success).toBe(false);
  });

  it("requires global success to match every repository", () => {
    expect(
      gitSyncReportSchema.safeParse({ status: "succeeded", repositories: [failedRepository] })
        .success
    ).toBe(false);
    expect(
      gitSyncReportSchema.safeParse({
        status: "failed",
        repositories: [{ ...failedRepository, status: "succeeded" }],
      }).success
    ).toBe(false);
    expect(gitSyncReportSchema.safeParse({ status: "failed", repositories: [] }).success).toBe(
      false
    );
  });

  it("keeps the fatal error string bounded alongside the report", () => {
    expect(
      sandboxErrorRequestSchema.safeParse({
        error: "x".repeat(1001),
        fatal: true,
        gitSyncReport: { status: "failed", repositories: [failedRepository] },
      }).success
    ).toBe(false);
  });
});
