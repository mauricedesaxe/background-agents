/**
 * Daytona sandbox provider — calls the Daytona REST API directly.
 *
 * Ports env-var assembly, label construction, tunnel-URL generation, and
 * code-server password derivation that previously lived in the Python shim.
 */

import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import { resolveServicePorts, resolveTunnelPorts } from "./port-resolution";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import type {
  DaytonaRestClient,
  DaytonaCreateSandboxParams,
  DaytonaSandboxListItem,
  DaytonaSandboxResponse,
  DaytonaSnapshotResponse,
} from "../daytona-rest-client";
import { DaytonaApiError, DaytonaNotFoundError } from "../daytona-rest-client";
import {
  buildSandboxEnvVars,
  deriveCodeServerPassword,
  deriveVncPassword,
  scmCloneIdentity,
} from "../sandbox-env";
import {
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ColdRecoveryConfig,
  type ResumeConfig,
  type ResumeResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type StopConfig,
  type StopResult,
  type VncAccess,
} from "../provider";

const log = createLogger("daytona-provider");

// ---------------------------------------------------------------------------
// Constants (ported from packages/daytona-infra/src/config.py)
// ---------------------------------------------------------------------------

const DEFAULT_PREVIEW_EXPIRY_SECONDS = 3900;
const RESUME_RECONCILE_INTERVAL_MS = 1_000;
const RESUME_RECONCILE_DEADLINE_MS = 30_000;
const COLD_RECOVERY_RECONCILE_INTERVAL_MS = 1_000;
const COLD_RECOVERY_RECONCILE_DEADLINE_MS = 120_000;

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

export interface DaytonaProviderConfig {
  scmProvider: SourceControlProviderName;
  gitlabAccessToken?: string;
  /** Secret used for domain-separated sandbox access password derivation. */
  sandboxAccessPasswordSecret: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = "daytona";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSandboxTimeout: false,
    supportsSnapshots: false,
    supportsRestore: false,
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: DaytonaRestClient,
    private readonly providerConfig: DaytonaProviderConfig
  ) {}

  // -----------------------------------------------------------------------
  // SandboxProvider interface
  // -----------------------------------------------------------------------

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const envVars = await this.buildEnvVars(config);
      const labels = this.buildLabels(config);

      const params: DaytonaCreateSandboxParams = {
        name: config.sandboxId,
        snapshot: this.client.config.baseSnapshot,
        env: envVars,
        labels,
        autoStopInterval: this.client.config.autoStopIntervalMinutes,
        autoArchiveInterval: this.client.config.autoArchiveIntervalMinutes,
        public: false,
      };
      if (this.client.config.target) {
        params.target = this.client.config.target;
      }

      const sandbox = await this.client.createSandbox(params);

      const { codeServerUrl, codeServerPassword, vncAccess, tunnelUrls } =
        await this.buildTunnelUrls(
          sandbox.id,
          config.sandboxId,
          config.timeoutSeconds,
          config.codeServerEnabled,
          config.vncEnabled,
          config.sandboxSettings
        );

      return {
        sandboxId: config.sandboxId,
        providerObjectId: sandbox.id,
        createdAt: Date.now(),
        codeServerUrl,
        codeServerPassword,
        vncAccess,
        tunnelUrls,
      };
    } catch (error) {
      throw this.classifyError("Failed to create Daytona sandbox", error);
    }
  }

  async recoverColdSandbox(config: ColdRecoveryConfig): Promise<CreateSandboxResult> {
    try {
      const labels = {
        ...this.buildLabels(config),
        openinspect_recovery_operation_id: config.operationId,
        openinspect_recovery_source_id: config.sourceProviderObjectId,
      };
      let replacement: DaytonaSandboxResponse | undefined = await this.findRecoveryReplacement(
        config,
        labels
      );
      if (!replacement) {
        const snapshot = await this.reconcileRecoverySnapshot(config);
        const params: DaytonaCreateSandboxParams = {
          name: config.replacementName,
          snapshot: snapshot.name,
          env: {
            ...(await this.buildEnvVars(config)),
            RESTORED_FROM_SNAPSHOT: "true",
          },
          labels,
          autoStopInterval: this.client.config.autoStopIntervalMinutes,
          autoArchiveInterval: this.client.config.autoArchiveIntervalMinutes,
          public: false,
          ...(this.client.config.target ? { target: this.client.config.target } : {}),
        };
        try {
          replacement = await this.client.createSandbox(params);
        } catch (error) {
          if (!(error instanceof DaytonaApiError) || error.status !== 409) throw error;
          replacement = await this.findRecoveryReplacement(config, labels);
          if (!replacement) throw error;
        }
      }
      if (!replacement) throw new Error("Daytona recovery replacement was not created");

      replacement = await this.ensureRecoveryReplacementStarted(replacement, config);
      return {
        sandboxId: config.sandboxId,
        providerObjectId: replacement.id,
        createdAt: Date.now(),
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to cold-recover Daytona sandbox", error);
    }
  }

  private async reconcileRecoverySnapshot(
    config: ColdRecoveryConfig
  ): Promise<DaytonaSnapshotResponse> {
    let snapshot = await this.findRecoverySnapshot(config);
    if (!snapshot) {
      await this.ensureRecoverySourceStopped(config.sourceProviderObjectId);
      try {
        await this.client.createSandboxSnapshot(config.sourceProviderObjectId, config.snapshotName);
      } catch (error) {
        if (!(error instanceof DaytonaApiError) || error.status !== 409) throw error;
      }
      snapshot = await this.waitForRecoverySnapshot(config);
    }
    const deadline = Date.now() + COLD_RECOVERY_RECONCILE_DEADLINE_MS;
    while (snapshot.state !== "active" && Date.now() < deadline) {
      if (["inactive", "error", "build_failed", "removing"].includes(snapshot.state)) {
        throw new Error(
          snapshot.errorReason || `Daytona recovery snapshot entered ${snapshot.state}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, COLD_RECOVERY_RECONCILE_INTERVAL_MS));
      snapshot = await this.client.getSnapshot(snapshot.id);
    }
    if (snapshot.state !== "active") {
      throw new Error("Timed out waiting for Daytona recovery snapshot");
    }
    if (snapshot.sourceSandboxId !== config.sourceProviderObjectId) {
      throw new Error("Daytona recovery snapshot source does not match the recovery operation");
    }
    return snapshot;
  }

  private async ensureRecoverySourceStopped(sourceProviderObjectId: string): Promise<void> {
    const source = await this.client.getSandbox(sourceProviderObjectId);
    if (source.state !== "stopped") {
      throw new Error("Daytona recovery source must already be stopped");
    }
  }

  private async waitForRecoverySnapshot(
    config: ColdRecoveryConfig
  ): Promise<DaytonaSnapshotResponse> {
    const deadline = Date.now() + COLD_RECOVERY_RECONCILE_DEADLINE_MS;
    let snapshot = await this.findRecoverySnapshot(config);
    while (!snapshot && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, COLD_RECOVERY_RECONCILE_INTERVAL_MS));
      snapshot = await this.findRecoverySnapshot(config);
    }
    if (!snapshot) throw new Error("Timed out discovering Daytona recovery snapshot");
    return snapshot;
  }

  private async findRecoverySnapshot(
    config: ColdRecoveryConfig
  ): Promise<DaytonaSnapshotResponse | undefined> {
    const snapshots = await this.client.listSnapshots({
      name: config.snapshotName,
      sourceSandboxId: config.sourceProviderObjectId,
    });
    return snapshots.find(
      (snapshot) =>
        snapshot.name === config.snapshotName &&
        snapshot.sourceSandboxId === config.sourceProviderObjectId
    );
  }

  private async findRecoveryReplacement(
    config: ColdRecoveryConfig,
    labels: Record<string, string>
  ): Promise<DaytonaSandboxListItem | undefined> {
    const candidates = await this.client.listSandboxes({
      name: config.replacementName,
      labels,
    });
    const exactName = candidates.filter((candidate) => candidate.name === config.replacementName);
    const replacement = exactName.find((candidate) =>
      Object.entries(labels).every(([key, value]) => candidate.labels[key] === value)
    );
    if (!replacement && exactName.length > 0) {
      throw new Error("Daytona recovery replacement name is owned by another operation");
    }
    return replacement;
  }

  private async ensureRecoveryReplacementStarted(
    replacement: DaytonaSandboxResponse,
    config: ColdRecoveryConfig
  ): Promise<DaytonaSandboxResponse> {
    if (replacement.state === "started") return replacement;
    try {
      await this.client.startSandbox(replacement.id);
    } catch (error) {
      if (!(error instanceof DaytonaApiError) || error.status !== 409) throw error;
    }
    const deadline = Date.now() + RESUME_RECONCILE_DEADLINE_MS;
    let current: DaytonaSandboxResponse = replacement;
    while (current.state !== "started" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, RESUME_RECONCILE_INTERVAL_MS));
      const sandbox = await this.client.getSandbox(replacement.id);
      current = sandbox;
    }
    if (current.state !== "started") {
      throw new Error(`Timed out starting Daytona recovery replacement ${config.replacementName}`);
    }
    return current;
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
      let sandbox;
      try {
        sandbox = await this.client.getSandbox(config.providerObjectId);
      } catch (error) {
        if (error instanceof DaytonaNotFoundError) {
          return {
            outcome: "replace",
            providerObjectId: config.providerObjectId,
            reason: "not_found",
          };
        }
        throw error;
      }

      if (sandbox.state !== "started") {
        try {
          if (
            (sandbox.state === "error" || sandbox.state === "build_failed") &&
            sandbox.recoverable
          ) {
            await this.client.recoverSandbox(config.providerObjectId);
          } else {
            await this.client.startSandbox(config.providerObjectId);
          }
        } catch (error) {
          if (error instanceof DaytonaNotFoundError) {
            return {
              outcome: "replace",
              providerObjectId: config.providerObjectId,
              reason: "not_found",
            };
          }
          if (!(error instanceof DaytonaApiError) || error.status !== 409) throw error;
        }

        const deadline = Date.now() + RESUME_RECONCILE_DEADLINE_MS;
        while (Date.now() < deadline) {
          try {
            sandbox = await this.client.getSandbox(config.providerObjectId);
          } catch (pollError) {
            if (pollError instanceof DaytonaNotFoundError) {
              return {
                outcome: "replace",
                providerObjectId: config.providerObjectId,
                reason: "not_found",
              };
            }
            throw pollError;
          }
          if (sandbox.state === "started") break;
          await new Promise((resolve) => setTimeout(resolve, RESUME_RECONCILE_INTERVAL_MS));
        }
        if (sandbox.state !== "started") {
          return {
            outcome: "retry",
            reason: "Timed out waiting for Daytona sandbox state transition",
          };
        }
      }

      // Tunnel URL generation runs after start so a preview-URL failure
      // doesn't mask a successful resume.
      let codeServerUrl: string | undefined;
      let codeServerPassword: string | undefined;
      let vncAccess: VncAccess | undefined;
      let tunnelUrls: Record<string, string> | undefined;
      try {
        const tunnels = await this.buildTunnelUrls(
          config.providerObjectId,
          config.sandboxId,
          config.timeoutSeconds,
          config.codeServerEnabled,
          config.vncEnabled,
          config.sandboxSettings
        );
        codeServerUrl = tunnels.codeServerUrl;
        codeServerPassword = tunnels.codeServerPassword;
        vncAccess = tunnels.vncAccess;
        tunnelUrls = tunnels.tunnelUrls;
      } catch (tunnelError) {
        log.warn("daytona.resume_tunnel_urls_failed", {
          sandbox_id: config.sandboxId,
          error: tunnelError instanceof Error ? tunnelError.message : String(tunnelError),
        });
      }

      return {
        outcome: "resumed",
        providerObjectId: sandbox.id,
        codeServerUrl,
        codeServerPassword,
        vncAccess,
        tunnelUrls,
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to resume Daytona sandbox", error);
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      try {
        if (config.reason === "respawn") {
          await this.client.deleteSandbox(
            config.providerObjectId,
            ...(config.signal ? [config.signal] : [])
          );
        } else {
          await this.client.stopSandbox(config.providerObjectId);
        }
      } catch (error) {
        if (error instanceof DaytonaNotFoundError) {
          return { success: true };
        }
        throw error;
      }
      return { success: true };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError(
        `Failed to ${config.reason === "respawn" ? "delete" : "stop"} Daytona sandbox`,
        error
      );
    }
  }

  // -----------------------------------------------------------------------
  // Env var assembly (ported from service.py _build_env)
  // -----------------------------------------------------------------------

  private async buildEnvVars(config: CreateSandboxConfig): Promise<Record<string, string>> {
    return buildSandboxEnvVars(config, {
      scmIdentity: scmCloneIdentity(this.providerConfig.scmProvider),
      codeServerPassword: config.codeServerEnabled
        ? await deriveCodeServerPassword(
            config.sandboxId,
            this.providerConfig.sandboxAccessPasswordSecret
          )
        : undefined,
      vncPassword: config.vncEnabled
        ? await deriveVncPassword(config.sandboxId, this.providerConfig.sandboxAccessPasswordSecret)
        : undefined,
    });
  }

  // -----------------------------------------------------------------------
  // Label assembly (ported from service.py _build_labels)
  // -----------------------------------------------------------------------

  private buildLabels(config: CreateSandboxConfig): Record<string, string> {
    return {
      openinspect_framework: "open-inspect",
      openinspect_session_id: config.sessionId,
      openinspect_expected_sandbox_id: config.sandboxId,
      ...(config.repoOwner && config.repoName
        ? { openinspect_repo: `${config.repoOwner}/${config.repoName}` }
        : {}),
    };
  }

  // -----------------------------------------------------------------------
  // Tunnel URL generation (ported from service.py _build_tunnel_urls)
  // -----------------------------------------------------------------------

  private async buildTunnelUrls(
    daytonaSandboxId: string,
    logicalSandboxId: string,
    timeoutSeconds: number | undefined,
    codeServerEnabled: boolean | undefined,
    vncEnabled: boolean | undefined,
    sandboxSettings: SandboxSettings | undefined
  ): Promise<{
    codeServerUrl?: string;
    codeServerPassword?: string;
    vncAccess?: VncAccess;
    tunnelUrls?: Record<string, string>;
  }> {
    const expirySeconds = resolvePreviewExpirySeconds(timeoutSeconds);
    const { codeServerPort, vncPort } = resolveServicePorts(sandboxSettings);
    let tunnelPorts = resolveTunnelPorts(sandboxSettings?.tunnelPorts);
    let codeServerUrl: string | undefined;
    let codeServerPassword: string | undefined;
    let vncAccess: VncAccess | undefined;

    if (codeServerEnabled) {
      const preview = await this.client.getSignedPreviewUrl(
        daytonaSandboxId,
        codeServerPort,
        expirySeconds
      );
      codeServerUrl = preview.url;
      codeServerPassword = await deriveCodeServerPassword(
        logicalSandboxId,
        this.providerConfig.sandboxAccessPasswordSecret
      );
      tunnelPorts = tunnelPorts.filter((p) => p !== codeServerPort);
    }

    if (vncEnabled) {
      const preview = await this.client.getSignedPreviewUrl(
        daytonaSandboxId,
        vncPort,
        expirySeconds
      );
      const password = await deriveVncPassword(
        logicalSandboxId,
        this.providerConfig.sandboxAccessPasswordSecret
      );
      vncAccess = { url: preview.url, password };
      tunnelPorts = tunnelPorts.filter((p) => p !== vncPort);
    }

    let tunnelUrls: Record<string, string> | undefined;
    if (tunnelPorts.length > 0) {
      const entries = await Promise.all(
        tunnelPorts.map(async (port) => {
          const preview = await this.client.getSignedPreviewUrl(
            daytonaSandboxId,
            port,
            expirySeconds
          );
          return [String(port), preview.url] as const;
        })
      );
      tunnelUrls = Object.fromEntries(entries);
    }

    return { codeServerUrl, codeServerPassword, vncAccess, tunnelUrls };
  }

  // -----------------------------------------------------------------------
  // Error classification
  // -----------------------------------------------------------------------

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof DaytonaApiError) {
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    return SandboxProviderError.fromFetchError(
      error instanceof Error ? `${message}: ${error.message}` : message,
      error
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers (ported from config.py)
// ---------------------------------------------------------------------------

function resolvePreviewExpirySeconds(timeoutSeconds: number | undefined): number {
  if (!timeoutSeconds) return DEFAULT_PREVIEW_EXPIRY_SECONDS;
  return Math.min(86400, Math.max(900, timeoutSeconds + 300));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDaytonaProvider(
  client: DaytonaRestClient,
  providerConfig: DaytonaProviderConfig
): DaytonaSandboxProvider {
  return new DaytonaSandboxProvider(client, providerConfig);
}
