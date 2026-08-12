/**
 * Create Pull Request Tool for Open-Inspect.
 *
 * This tool creates a pull request for committed changes.
 * Uses tool() helper from @opencode-ai/plugin with tool.schema for Zod compatibility.
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Debug: Log that the tool was loaded
console.log("[create-pull-request] Tool module loaded");
console.log(
  "[create-pull-request] CONTROL_PLANE_URL:",
  process.env.CONTROL_PLANE_URL || "<not set>"
);
console.log(
  "[create-pull-request] SANDBOX_AUTH_TOKEN:",
  process.env.SANDBOX_AUTH_TOKEN ? "<set>" : "<not set>"
);
console.log(
  "[create-pull-request] SESSION_CONFIG:",
  process.env.SESSION_CONFIG ? "<set>" : "<not set>"
);

// Get bridge configuration from environment
const BRIDGE_URL = process.env.CONTROL_PLANE_URL || "http://localhost:8787";
const BRIDGE_TOKEN = process.env.SANDBOX_AUTH_TOKEN || "";

// Get session ID from SESSION_CONFIG
function getSessionId() {
  try {
    const config = JSON.parse(process.env.SESSION_CONFIG || "{}");
    console.log(
      "[create-pull-request] Parsed SESSION_CONFIG, sessionId:",
      config.sessionId || config.session_id || "<not found>"
    );
    return config.sessionId || config.session_id || "";
  } catch (e) {
    console.log("[create-pull-request] Failed to parse SESSION_CONFIG:", e.message);
    return "";
  }
}

// Canonical repository manifest written by the supervisor — the single owner
// of the /workspace checkout layout. Mirrors REPO_MANIFEST_FILE_PATH in
// sandbox_runtime/constants.py.
const REPO_MANIFEST_PATH = "/tmp/oi-repo-manifest.json";

// Ordered repository list {owner, name, path} from the supervisor's manifest
// (empty when the manifest is absent, e.g. tool run outside a sandbox boot).
function getRepositories() {
  try {
    const manifest = JSON.parse(readFileSync(REPO_MANIFEST_PATH, "utf8"));
    const repositories = Array.isArray(manifest?.repositories) ? manifest.repositories : [];
    return repositories
      .map((entry) => ({
        owner: String(entry?.owner || "").trim(),
        name: String(entry?.name || "").trim(),
        path: String(entry?.path || "").trim(),
      }))
      .filter((entry) => entry.owner && entry.name && entry.path);
  } catch (e) {
    console.log("[create-pull-request] Failed to read repo manifest:", e.message);
    return [];
  }
}

async function getCurrentBranch(repoPath) {
  try {
    const gitArgs = repoPath
      ? ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]
      : ["rev-parse", "--abbrev-ref", "HEAD"];
    const { stdout } = await execFileAsync("git", gitArgs, {
      timeout: 5000,
    });
    const branch = stdout.trim();
    if (!branch || branch === "HEAD") {
      return undefined;
    }
    return branch;
  } catch (e) {
    console.log("[create-pull-request] Failed to resolve current branch:", e.message);
    return undefined;
  }
}

// Run a jj subcommand inside `repoPath`. Returns trimmed stdout.
async function jj(repoPath, jjArgs) {
  const { stdout } = await execFileAsync("jj", ["--repository", repoPath, ...jjArgs], {
    timeout: 15000,
  });
  return stdout.trim();
}

/**
 * Finalize a colocated Jujutsu (jj) working copy so git HEAD includes all of
 * the agent's uncommitted work before the PR is pushed.
 *
 * The control plane pushes git HEAD to the PR branch. But in a colocated jj
 * repo, jj keeps git HEAD at the PARENT of jj's working-copy commit `@`, so any
 * uncommitted changes in `@` are absent from HEAD and would be silently dropped
 * from the PR. We fix that here by finalizing `@` into a real commit and
 * exporting it to git HEAD.
 *
 * This is a complete no-op for plain git repos (no `.jj` directory) so existing
 * PR behavior is unchanged. The sequence is idempotent: if `@` is already empty
 * (the agent committed everything itself), we do NOT create an empty commit.
 *
 * Verified against jj 0.43.0. Notes:
 *  - jj needs its own identity to commit; `jj git init --colocate` does not copy
 *    git's user.name/user.email. We set it (repo-local) from git's config right
 *    before committing. jj warns that the setting only affects future commits,
 *    but `jj commit` rewrites `@` into a new commit that DOES pick up the
 *    freshly-set identity, so the resulting HEAD is authored correctly.
 *  - `jj log -r @ -T empty` prints "true"/"false" to detect whether `@` has
 *    changes, so we only commit when there is work to finalize.
 */
async function finalizeJujutsuWorkingCopy(repoPath, commitMessage) {
  // No-op unless this repo is a colocated jj checkout.
  if (!existsSync(join(repoPath, ".jj"))) {
    return;
  }

  console.log(`[create-pull-request] Colocated jj repo detected at ${repoPath}; finalizing @`);

  try {
    // jj needs an identity to author a commit. `--colocate` does not inherit
    // git's, so seed it (repo-local) from git's config. Idempotent.
    const gitName = await execFileAsync("git", ["-C", repoPath, "config", "user.name"], {
      timeout: 5000,
    })
      .then((r) => r.stdout.trim())
      .catch(() => "");
    const gitEmail = await execFileAsync("git", ["-C", repoPath, "config", "user.email"], {
      timeout: 5000,
    })
      .then((r) => r.stdout.trim())
      .catch(() => "");
    if (gitName) {
      await jj(repoPath, ["config", "set", "--repo", "user.name", gitName]);
    }
    if (gitEmail) {
      await jj(repoPath, ["config", "set", "--repo", "user.email", gitEmail]);
    }

    // Only finalize when `@` actually has changes, so a repo where the agent
    // already committed everything doesn't gain a stray empty commit.
    const isEmpty =
      (await jj(repoPath, ["log", "-r", "@", "-T", "empty", "--no-graph"])) === "true";
    if (!isEmpty) {
      console.log("[create-pull-request] jj @ is non-empty; committing to finalize");
      await jj(repoPath, ["commit", "-m", commitMessage]);
    } else {
      console.log("[create-pull-request] jj @ is empty; nothing to finalize");
    }

    // Push the finalized jj commit(s) into the underlying git repo's HEAD/refs
    // so the control plane pushes the complete work.
    await jj(repoPath, ["git", "export"]);
    console.log("[create-pull-request] jj working copy finalized and exported to git HEAD");
  } catch (e) {
    // Don't let a jj hiccup swallow the PR flow silently — surface it, but let
    // the caller decide. We rethrow so the PR isn't created from a stale HEAD.
    console.log(`[create-pull-request] Failed to finalize jj working copy: ${e.message}`);
    throw e;
  }
}

// Use tool() helper - args should be a ZodRawShape (plain object), NOT a ZodObject
// OpenCode wraps it with z.object() internally
export default tool({
  name: "create-pull-request",
  description:
    "Create a pull request for the committed changes. DO NOT use 'gh' CLI - use this tool instead. It handles git push and PR creation automatically with pre-configured authentication. You MUST provide a descriptive title and body that explain what changes were made. Call this after committing your changes.",
  args: {
    title: z
      .string()
      .describe(
        "Title of the pull request. Should be concise and descriptive of the changes made."
      ),
    body: z
      .string()
      .describe(
        "Body/description of the pull request. Explain what changes were made and why. Use markdown formatting for clarity."
      ),
    baseBranch: z
      .string()
      .optional()
      .describe("Target branch to merge into. Defaults to the session's base branch."),
    repo: z
      .string()
      .optional()
      .describe(
        'Target repository as "owner/name". Required when the session spans multiple ' +
          "repositories; may be omitted for single-repository sessions."
      ),
  },
  async execute(args, context) {
    console.log(`[create-pull-request] execute() called with args:`, JSON.stringify(args));
    const title = args.title || "Changes from OpenCode session";
    const body = args.body || "Automated PR created via create-pull-request tool";
    const baseBranch = args.baseBranch; // undefined if not provided, server will use default

    // Resolve the target repository for multi-repo sessions.
    const repositories = getRepositories();
    const validValues = repositories.map((r) => `${r.owner}/${r.name}`).join(", ");
    let repoOwner;
    let repoName;
    let repoPath;
    if (args.repo) {
      const parts = String(args.repo).trim().split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return `Failed to create pull request: repo must be "owner/name"${
          validValues ? ` (one of: ${validValues})` : ""
        }.`;
      }
      const [ownerArg, nameArg] = parts;
      const match = repositories.find(
        (r) =>
          r.owner.toLowerCase() === ownerArg.toLowerCase() &&
          r.name.toLowerCase() === nameArg.toLowerCase()
      );
      if (repositories.length > 0 && !match) {
        return `Failed to create pull request: ${args.repo} is not part of this session. Valid values: ${validValues}.`;
      }
      // Use the manifest's canonical casing and path — checkout directories
      // and the control plane's member records are case-sensitive even
      // though the match above is not.
      repoOwner = match ? match.owner : ownerArg;
      repoName = match ? match.name : nameArg;
      repoPath = match ? match.path : undefined;
    } else if (repositories.length > 1) {
      return `Failed to create pull request: this session spans multiple repositories — pass repo with one of: ${validValues}.`;
    }

    // Resolve the directory the git/jj commands operate on. When repo wasn't
    // specified and the session has exactly one repo, use that repo's path;
    // otherwise fall back to the process cwd (matches getCurrentBranch, which
    // runs git without -C when repoPath is undefined).
    const effectiveRepoPath =
      repoPath || (repositories.length === 1 ? repositories[0].path : undefined) || process.cwd();

    // If this is a colocated jj repo, finalize the working copy so git HEAD
    // (what the control plane pushes) contains all uncommitted work. No-op for
    // plain git repos. For multi-repo sessions this only finalizes the single
    // target repo resolved above; other repos are untouched, which is correct
    // since only the target repo's HEAD is pushed for this PR.
    try {
      await finalizeJujutsuWorkingCopy(effectiveRepoPath, title);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to create pull request: could not finalize Jujutsu working copy (${message}). Your uncommitted changes were not included, so no PR was created.`;
    }

    const headBranch = await getCurrentBranch(repoPath);

    try {
      const sessionId = getSessionId();
      console.log(`[create-pull-request] Session ID: ${sessionId || "<empty>"}`);
      console.log(`[create-pull-request] Bridge URL: ${BRIDGE_URL}`);
      console.log(`[create-pull-request] Bridge Token: ${BRIDGE_TOKEN ? "<set>" : "<not set>"}`);

      if (!sessionId) {
        console.log("[create-pull-request] ERROR: Session ID not found");
        return "Failed to create pull request: Session ID not found in environment. Please check that SESSION_CONFIG is set correctly.";
      }

      // Use the session-specific endpoint
      const url = `${BRIDGE_URL}/sessions/${sessionId}/pr`;
      console.log(`[create-pull-request] Calling PR endpoint: ${url}`);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BRIDGE_TOKEN}`,
        },
        body: JSON.stringify({
          title: title,
          body: body,
          baseBranch: baseBranch,
          headBranch: headBranch,
          repoOwner: repoOwner,
          repoName: repoName,
          timestamp: Date.now(),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        // Try to parse as JSON to get structured error message
        let errorMessage = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error || errorJson.message || errorText;
        } catch {
          // Use raw text if not JSON
        }

        // Provide helpful messages based on status code
        let userMessage = `Failed to create pull request: ${errorMessage}`;
        if (response.status === 401) {
          userMessage = `Authentication failed: ${errorMessage}. The GitHub token may have expired - please re-authenticate.`;
        } else if (response.status === 404) {
          userMessage = `Session not found: ${errorMessage}. The session may have been deleted or the ID is incorrect.`;
        } else if (response.status === 409) {
          userMessage = `Conflict: ${errorMessage}. A PR may already exist for this branch.`;
        }

        console.log(`[create-pull-request] ERROR: HTTP ${response.status} - ${errorMessage}`);
        return userMessage;
      }

      const result = await response.json();

      if (result?.status === "manual" && result?.createPrUrl) {
        console.log("[create-pull-request] SUCCESS: branch pushed, manual PR URL generated");
        return `Branch pushed successfully.\n\nCreate the pull request in GitHub:\n${result.createPrUrl}\n\nUse your logged-in GitHub account to finish creating the PR.`;
      }

      console.log(`[create-pull-request] SUCCESS: PR #${result.prNumber} created`);
      return `Pull request created successfully!\n\nPR #${result.prNumber}: ${result.prUrl}\n\nThe PR is now ready for review.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[create-pull-request] ERROR: ${message}`);
      return `Failed to create pull request: ${message}`;
    }
  },
});
