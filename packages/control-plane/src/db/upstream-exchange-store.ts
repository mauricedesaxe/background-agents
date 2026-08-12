import {
  classificationMatchesDirection,
  type UpstreamExchangeClassification,
  type UpstreamExchangeDirection,
  type UpstreamExchangeUsefulUnit,
} from "@open-inspect/shared";
import type { SqlDatabase } from "./sql-database";

interface ScanRow {
  id: string;
  automation_id: string;
  automation_run_id: string;
  direction: UpstreamExchangeDirection;
  source_repository: string;
  from_sha: string | null;
  to_sha: string;
  fork_head_sha: string;
  upstream_head_sha: string;
  merge_base_sha: string;
  expected_commit_shas: string;
  report_channel_id: string | null;
  report_message_ts: string | null;
  report_permalink: string | null;
  finalized_at: number | null;
}

export class UpstreamExchangeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamExchangeConflictError";
  }
}

interface DispositionRow {
  classification: UpstreamExchangeClassification;
  evidence: string;
  affected_packages: string;
  terraform_impact: string;
  migration_impact: string;
  divergence_entries: string;
  test_hand_merge: number;
  semantic_port_evidence: string;
  useful_unit: UpstreamExchangeUsefulUnit | null;
  proposed_artifact: string | null;
}

export interface UpstreamExchangeDispositionInput {
  classification: UpstreamExchangeClassification;
  evidence: string;
  affectedPackages: string[];
  terraformImpact: string;
  migrationImpact: string;
  divergenceEntries: string[];
  testHandMerge: boolean;
  semanticPortEvidence: string;
  usefulUnit: UpstreamExchangeUsefulUnit | null;
  proposedArtifact: string | null;
}

export type ScanFinalization =
  | { kind: "none" }
  | { kind: "finalized"; scanId: string; runTransitioned: boolean }
  | { kind: "blocked"; scanId: string; reason: string };

function normalizeSourceRepository(value: string): string {
  return value.toLowerCase();
}

function normalizeCommitSha(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(normalized)) {
    throw new UpstreamExchangeConflictError("Commit identities must use full Git SHAs");
  }
  return normalized;
}

export class UpstreamExchangeStore {
  constructor(private readonly db: SqlDatabase) {}

  async getCursor(
    automationId: string,
    direction: UpstreamExchangeDirection,
    sourceRepository: string
  ): Promise<string | null> {
    const normalizedRepository = normalizeSourceRepository(sourceRepository);
    const row = await this.db
      .prepare(
        `SELECT to_sha FROM upstream_exchange_scans
         WHERE automation_id = ? AND direction = ? AND source_repository = ?
           AND finalized_at IS NOT NULL
         ORDER BY finalized_at DESC, created_at DESC LIMIT 1`
      )
      .bind(automationId, direction, normalizedRepository)
      .first<{ to_sha: string }>();
    return row?.to_sha ?? null;
  }

  async beginScan(params: {
    id: string;
    automationId: string;
    automationRunId: string;
    direction: UpstreamExchangeDirection;
    sourceRepository: string;
    fromSha: string | null;
    toSha: string;
    forkHeadSha: string;
    upstreamHeadSha: string;
    mergeBaseSha: string;
    expectedCommitShas: string[];
  }): Promise<{ id: string; resumed: boolean; classifiedCommitShas: string[] }> {
    const sourceRepository = normalizeSourceRepository(params.sourceRepository);
    const fromSha = params.fromSha === null ? null : normalizeCommitSha(params.fromSha);
    const toSha = normalizeCommitSha(params.toSha);
    const forkHeadSha = normalizeCommitSha(params.forkHeadSha);
    const upstreamHeadSha = normalizeCommitSha(params.upstreamHeadSha);
    const mergeBaseSha = normalizeCommitSha(params.mergeBaseSha);
    const expectedCommitShas = params.expectedCommitShas.map(normalizeCommitSha);
    if (new Set(expectedCommitShas).size !== expectedCommitShas.length) {
      throw new UpstreamExchangeConflictError("Expected commits must not contain duplicates");
    }
    if (
      (params.direction === "outbound" && toSha !== forkHeadSha) ||
      (params.direction === "inbound" && toSha !== upstreamHeadSha)
    ) {
      throw new UpstreamExchangeConflictError(
        "Scan toSha must match the source head for its direction"
      );
    }

    const existing = await this.getScanForRun(params.automationRunId);
    if (existing) {
      const same =
        existing.automation_id === params.automationId &&
        existing.direction === params.direction &&
        existing.source_repository === sourceRepository &&
        existing.from_sha === fromSha &&
        existing.to_sha === toSha &&
        existing.fork_head_sha === forkHeadSha &&
        existing.upstream_head_sha === upstreamHeadSha &&
        existing.merge_base_sha === mergeBaseSha &&
        existing.expected_commit_shas === JSON.stringify(expectedCommitShas);
      if (!same) {
        throw new UpstreamExchangeConflictError(
          "This automation run already owns a different exchange scan"
        );
      }
      return {
        id: existing.id,
        resumed: true,
        classifiedCommitShas: await this.getClassifiedCommitShas(existing, expectedCommitShas),
      };
    }

    const cursor = await this.getCursor(params.automationId, params.direction, sourceRepository);
    if (cursor !== fromSha) {
      throw new UpstreamExchangeConflictError(
        `Exchange cursor changed: expected ${cursor ?? "no cursor"}`
      );
    }

    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO upstream_exchange_scans
         (id, automation_id, automation_run_id, direction, source_repository,
          from_sha, to_sha, fork_head_sha, upstream_head_sha, merge_base_sha,
          expected_commit_shas, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        params.id,
        params.automationId,
        params.automationRunId,
        params.direction,
        sourceRepository,
        fromSha,
        toSha,
        forkHeadSha,
        upstreamHeadSha,
        mergeBaseSha,
        JSON.stringify(expectedCommitShas),
        now,
        now
      )
      .run();
    return {
      id: params.id,
      resumed: false,
      classifiedCommitShas: await this.getClassifiedCommitShas(
        {
          automation_id: params.automationId,
          direction: params.direction,
          source_repository: sourceRepository,
        },
        expectedCommitShas
      ),
    };
  }

  async recordDisposition(params: {
    scanId: string;
    automationId: string;
    automationRunId: string;
    commitSha: string;
    disposition: UpstreamExchangeDispositionInput;
  }): Promise<{ repeated: boolean }> {
    const scan = await this.getOwnedScan(
      params.scanId,
      params.automationId,
      params.automationRunId
    );
    if (!scan) {
      throw new UpstreamExchangeConflictError("Exchange scan not found for this automation run");
    }
    if (scan.finalized_at !== null) {
      throw new UpstreamExchangeConflictError("Exchange scan is already finalized");
    }
    if (!classificationMatchesDirection(scan.direction, params.disposition.classification)) {
      throw new UpstreamExchangeConflictError(
        `Classification does not apply to ${scan.direction} scans`
      );
    }
    if (
      (params.disposition.classification === "candidate") !==
      (params.disposition.usefulUnit !== null)
    ) {
      throw new UpstreamExchangeConflictError(
        "Useful unit must be set only for candidate classifications"
      );
    }
    if (scan.direction === "outbound" && params.disposition.proposedArtifact !== null) {
      throw new UpstreamExchangeConflictError(
        "Proposed artifacts apply only to inbound classifications"
      );
    }
    if (!params.disposition.semanticPortEvidence.trim()) {
      throw new UpstreamExchangeConflictError("Semantic port evidence is required");
    }

    const expected = JSON.parse(scan.expected_commit_shas) as string[];
    const commitSha = normalizeCommitSha(params.commitSha);
    if (!expected.includes(commitSha)) {
      throw new UpstreamExchangeConflictError("Commit is not part of this scan's expected range");
    }

    const value = params.disposition;
    const encodedPackages = JSON.stringify(value.affectedPackages);
    const encodedDivergences = JSON.stringify(value.divergenceEntries);
    const now = Date.now();
    const inserted = await this.db
      .prepare(
        `INSERT OR IGNORE INTO upstream_exchange_dispositions
         (automation_id, direction, source_repository, commit_sha, classification,
          evidence, affected_packages, terraform_impact, migration_impact,
           divergence_entries, test_hand_merge, semantic_port_evidence,
           useful_unit, proposed_artifact, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        params.automationId,
        scan.direction,
        scan.source_repository,
        commitSha,
        value.classification,
        value.evidence,
        encodedPackages,
        value.terraformImpact,
        value.migrationImpact,
        encodedDivergences,
        value.testHandMerge ? 1 : 0,
        value.semanticPortEvidence,
        value.usefulUnit,
        value.proposedArtifact,
        now,
        now
      )
      .run();
    if ((inserted.meta?.changes ?? 0) > 0) return { repeated: false };

    const existing = await this.db
      .prepare(
        `SELECT classification, evidence, affected_packages, terraform_impact,
                 migration_impact, divergence_entries, test_hand_merge,
                 semantic_port_evidence, useful_unit, proposed_artifact
         FROM upstream_exchange_dispositions
         WHERE automation_id = ? AND direction = ? AND source_repository = ? AND commit_sha = ?`
      )
      .bind(params.automationId, scan.direction, scan.source_repository, commitSha)
      .first<DispositionRow>();
    const same =
      existing !== null &&
      existing.classification === value.classification &&
      existing.evidence === value.evidence &&
      existing.affected_packages === encodedPackages &&
      existing.terraform_impact === value.terraformImpact &&
      existing.migration_impact === value.migrationImpact &&
      existing.divergence_entries === encodedDivergences &&
      existing.test_hand_merge === (value.testHandMerge ? 1 : 0) &&
      existing.semantic_port_evidence === value.semanticPortEvidence &&
      existing.useful_unit === value.usefulUnit &&
      existing.proposed_artifact === value.proposedArtifact;
    if (!same) {
      throw new UpstreamExchangeConflictError("Commit already has a different durable disposition");
    }
    return { repeated: true };
  }

  async recordSlackDelivery(params: {
    scanId: string;
    automationId: string;
    automationRunId: string;
    channelId: string;
    messageTs: string;
    permalink: string;
  }): Promise<void> {
    if (!params.permalink) {
      throw new UpstreamExchangeConflictError("Slack delivery permalink is required");
    }
    const scan = await this.requireOpenScan(
      params.scanId,
      params.automationId,
      params.automationRunId
    );
    if (scan.report_message_ts !== null) {
      if (
        scan.report_channel_id === params.channelId &&
        scan.report_message_ts === params.messageTs &&
        scan.report_permalink === params.permalink
      ) {
        return;
      }
      throw new UpstreamExchangeConflictError(
        "Exchange scan already has a different Slack delivery receipt"
      );
    }

    const now = Date.now();
    await this.db
      .prepare(
        `UPDATE upstream_exchange_scans
         SET report_channel_id = ?, report_message_ts = ?, report_permalink = ?,
             report_delivered_at = ?, updated_at = ?
         WHERE id = ? AND automation_id = ? AND automation_run_id = ? AND finalized_at IS NULL`
      )
      .bind(
        params.channelId,
        params.messageTs,
        params.permalink,
        now,
        now,
        params.scanId,
        params.automationId,
        params.automationRunId
      )
      .run();
  }

  async assertOpenScan(
    scanId: string,
    automationId: string,
    automationRunId: string
  ): Promise<void> {
    await this.requireOpenScan(scanId, automationId, automationRunId);
  }

  async finalizeForRun(automationRunId: string): Promise<ScanFinalization> {
    const scan = await this.getScanForRun(automationRunId);
    if (!scan) return { kind: "none" };
    if (scan.finalized_at !== null) {
      return { kind: "finalized", scanId: scan.id, runTransitioned: false };
    }

    const now = Date.now();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE upstream_exchange_scans AS scan
           SET finalized_at = ?, updated_at = ?
           WHERE scan.id = ?
             AND scan.finalized_at IS NULL
              AND scan.report_channel_id IS NOT NULL
              AND scan.report_message_ts IS NOT NULL
              AND scan.report_permalink IS NOT NULL
              AND scan.report_permalink != ''
             AND EXISTS (
               SELECT 1 FROM automation_runs AS run
               WHERE run.id = scan.automation_run_id AND run.status IN ('starting', 'running')
             )
             AND scan.from_sha IS (
               SELECT previous.to_sha FROM upstream_exchange_scans AS previous
               WHERE previous.automation_id = scan.automation_id
                 AND previous.direction = scan.direction
                 AND previous.source_repository = scan.source_repository
                 AND previous.finalized_at IS NOT NULL
               ORDER BY previous.finalized_at DESC, previous.created_at DESC LIMIT 1
             )
             AND NOT EXISTS (
               SELECT 1 FROM json_each(scan.expected_commit_shas) AS expected
               WHERE NOT EXISTS (
                 SELECT 1 FROM upstream_exchange_dispositions AS disposition
                 WHERE disposition.automation_id = scan.automation_id
                   AND disposition.direction = scan.direction
                   AND disposition.source_repository = scan.source_repository
                   AND disposition.commit_sha = expected.value
               )
             )`
        )
        .bind(now, now, scan.id),
      this.db
        .prepare(
          `UPDATE automation_runs
           SET status = 'completed', completed_at = ?
           WHERE id = ? AND status IN ('starting', 'running')
             AND EXISTS (
               SELECT 1 FROM upstream_exchange_scans
               WHERE id = ? AND finalized_at = ?
             )`
        )
        .bind(now, automationRunId, scan.id, now),
    ]);
    const scanFinalized = (results[0]?.meta?.changes ?? 0) > 0;
    const runTransitioned = (results[1]?.meta?.changes ?? 0) > 0;
    if (scanFinalized && runTransitioned) {
      return { kind: "finalized", scanId: scan.id, runTransitioned: true };
    }

    const latest = await this.getScanForRun(automationRunId);
    if (latest?.finalized_at !== null && latest?.finalized_at !== undefined) {
      return { kind: "finalized", scanId: scan.id, runTransitioned: false };
    }

    const missing = await this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM json_each(?) AS expected
         WHERE NOT EXISTS (
           SELECT 1 FROM upstream_exchange_dispositions AS disposition
           WHERE disposition.automation_id = ? AND disposition.direction = ?
             AND disposition.source_repository = ? AND disposition.commit_sha = expected.value
         )`
      )
      .bind(scan.expected_commit_shas, scan.automation_id, scan.direction, scan.source_repository)
      .first<{ count: number }>();
    const cursor = await this.getCursor(scan.automation_id, scan.direction, scan.source_repository);
    const run = await this.db
      .prepare(`SELECT status FROM automation_runs WHERE id = ?`)
      .bind(automationRunId)
      .first<{ status: string }>();
    if (!run || !["starting", "running"].includes(run.status)) {
      return { kind: "blocked", scanId: scan.id, reason: "The automation run is no longer active" };
    }
    if (!scan.report_message_ts || !scan.report_permalink) {
      return { kind: "blocked", scanId: scan.id, reason: "Slack delivery receipt is missing" };
    }
    if ((missing?.count ?? 0) > 0) {
      return {
        kind: "blocked",
        scanId: scan.id,
        reason: `${missing?.count ?? 0} expected commits have no disposition`,
      };
    }
    if (cursor !== scan.from_sha) {
      return {
        kind: "blocked",
        scanId: scan.id,
        reason: "The finalized cursor changed while this scan was running",
      };
    }
    return {
      kind: "blocked",
      scanId: scan.id,
      reason: "Scan finalization preconditions were not met",
    };
  }

  private getScanForRun(automationRunId: string): Promise<ScanRow | null> {
    return this.db
      .prepare(`SELECT * FROM upstream_exchange_scans WHERE automation_run_id = ?`)
      .bind(automationRunId)
      .first<ScanRow>();
  }

  private getOwnedScan(
    scanId: string,
    automationId: string,
    automationRunId: string
  ): Promise<ScanRow | null> {
    return this.db
      .prepare(
        `SELECT * FROM upstream_exchange_scans
         WHERE id = ? AND automation_id = ? AND automation_run_id = ?`
      )
      .bind(scanId, automationId, automationRunId)
      .first<ScanRow>();
  }

  private async getClassifiedCommitShas(
    scan: Pick<ScanRow, "automation_id" | "direction" | "source_repository">,
    expectedCommitShas: string[]
  ): Promise<string[]> {
    if (expectedCommitShas.length === 0) return [];
    const rows = await this.db
      .prepare(
        `SELECT commit_sha FROM upstream_exchange_dispositions
         WHERE automation_id = ? AND direction = ? AND source_repository = ?`
      )
      .bind(scan.automation_id, scan.direction, scan.source_repository)
      .all<{ commit_sha: string }>();
    const classified = new Set((rows.results ?? []).map((row) => row.commit_sha));
    return expectedCommitShas.filter((sha) => classified.has(sha));
  }

  private async requireOpenScan(
    scanId: string,
    automationId: string,
    automationRunId: string
  ): Promise<ScanRow> {
    const scan = await this.getOwnedScan(scanId, automationId, automationRunId);
    if (!scan) {
      throw new UpstreamExchangeConflictError("Exchange scan not found for this automation run");
    }
    if (scan.finalized_at !== null) {
      throw new UpstreamExchangeConflictError("Exchange scan is already finalized");
    }
    return scan;
  }
}
