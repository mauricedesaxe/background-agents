import type { McpServerConfig } from "@open-inspect/shared";
import type { SessionRepositoryInfo } from "./provider";
import type { SourceControlProviderName } from "../source-control/types";

/**
 * Shared assembly for the sandbox environment contract.
 *
 * The runtime decodes the `SESSION_CONFIG` env var into a single canonical
 * shape (see the Python `SessionConfig` in
 * `packages/sandbox-runtime/src/sandbox_runtime/types.py`). Every provider used
 * to hand-roll that object independently, which let fields silently diverge —
 * the Daytona provider dropped `mcp_servers` entirely because its local copy
 * never added the key. This module is the single source of truth for the shape
 * so providers serialize it instead of reassembling ad-hoc objects.
 *
 * The runtime reads `session_id`, `branch`, `provider`, `model`, and
 * `mcp_servers` from this payload; `repo_owner` / `repo_name` are included to
 * mirror the full contract.
 */

/** Snake_case wire twin of {@link SessionRepositoryInfo} (runtime SessionRepositoryConfig). */
export interface SessionRepositoryConfigPayload {
  repo_owner: string;
  repo_name: string;
  branch: string;
}

/** Canonical `SESSION_CONFIG` payload handed to the sandbox runtime. */
export interface SessionConfigPayload {
  session_id: string;
  repo_owner: string | null;
  repo_name: string | null;
  provider: string;
  model: string;
  /** Omitted from the serialized payload when undefined. */
  mcp_servers?: McpServerConfig[];
  /** Omitted from the serialized payload when undefined. */
  branch?: string | null;
  /** Ordered member list; only present for multi-repo sessions. */
  repositories?: SessionRepositoryConfigPayload[];
}

/** Provider-agnostic inputs needed to assemble a {@link SessionConfigPayload}. */
export interface SessionConfigInput {
  sessionId: string;
  repoOwner: string | null;
  repoName: string | null;
  provider: string;
  model: string;
  mcpServers?: McpServerConfig[];
  branch?: string | null;
  repositories?: SessionRepositoryInfo[];
}

/**
 * Build the canonical `SESSION_CONFIG` payload from provider inputs.
 *
 * `mcp_servers` is always set (left undefined when absent) so `JSON.stringify`
 * omits it — matching how the runtime treats an absent key and an empty list
 * identically. `branch` is only omitted when undefined; null is serialized to
 * explicitly represent a no-repository session.
 */
export function buildSessionConfig(input: SessionConfigInput): SessionConfigPayload {
  const payload: SessionConfigPayload = {
    session_id: input.sessionId,
    repo_owner: input.repoOwner,
    repo_name: input.repoName,
    provider: input.provider,
    model: input.model,
    mcp_servers: input.mcpServers,
  };
  if (input.branch !== undefined) {
    payload.branch = input.branch;
  }
  if (input.repositories?.length) {
    payload.repositories = input.repositories.map(toRepositoryConfigPayload);
  }
  return payload;
}

export function toRepositoryConfigPayload(
  repository: SessionRepositoryInfo
): SessionRepositoryConfigPayload {
  return {
    repo_owner: repository.repoOwner,
    repo_name: repository.repoName,
    branch: repository.baseBranch,
  };
}

/** Host/username pair git pairs with the brokered clone token in the sandbox. */
export interface ScmCloneIdentity {
  /** `VCS_HOST` — hostname the credential helper and clone URLs target. */
  readonly host: string;
  /** `VCS_CLONE_USERNAME` — username git sends alongside the brokered token. */
  readonly cloneUsername: string;
  /** Hosts an SCM credential secret may be released to (clone host + API host). */
  readonly secretHosts: readonly string[];
}

const SCM_CLONE_IDENTITIES: Record<SourceControlProviderName, ScmCloneIdentity> = {
  github: {
    host: "github.com",
    cloneUsername: "x-access-token",
    secretHosts: ["github.com", "api.github.com"],
  },
  gitlab: {
    host: "gitlab.com",
    cloneUsername: "oauth2",
    secretHosts: ["gitlab.com", "api.gitlab.com"],
  },
  bitbucket: {
    host: "bitbucket.org",
    cloneUsername: "x-token-auth",
    secretHosts: ["bitbucket.org", "api.bitbucket.org"],
  },
};

/**
 * Keyed exhaustively by provider so adding one is a compile error here rather
 * than a silent fallback in each caller.
 */
export function scmCloneIdentity(scmProvider: SourceControlProviderName): ScmCloneIdentity {
  return SCM_CLONE_IDENTITIES[scmProvider];
}
