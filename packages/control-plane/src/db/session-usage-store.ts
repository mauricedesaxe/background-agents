import type { SqlDatabase } from "./sql-database";

export interface SessionUsageFact {
  sessionId: string;
  eventId: string;
  observedAt: number;
  costEstimate: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface SessionUsageTotals {
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface SessionUsageTotalsRow {
  total_cost: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export class SessionUsageStore {
  constructor(private readonly db: SqlDatabase) {}

  async record(fact: SessionUsageFact): Promise<SessionUsageTotals> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO session_usage_facts (
           session_id, event_id, observed_at, cost_estimate, total_tokens,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        fact.sessionId,
        fact.eventId,
        fact.observedAt,
        fact.costEstimate,
        fact.totalTokens,
        fact.inputTokens,
        fact.outputTokens,
        fact.cacheReadTokens,
        fact.cacheWriteTokens
      )
      .run();

    await this.db
      .prepare(
        `UPDATE sessions SET
           total_cost = MAX(total_cost, usage_cost_baseline + COALESCE((SELECT SUM(cost_estimate) FROM session_usage_facts WHERE session_id = ?), 0)),
           total_tokens = COALESCE((SELECT SUM(total_tokens) FROM session_usage_facts WHERE session_id = ?), 0),
           input_tokens = COALESCE((SELECT SUM(input_tokens) FROM session_usage_facts WHERE session_id = ?), 0),
           output_tokens = COALESCE((SELECT SUM(output_tokens) FROM session_usage_facts WHERE session_id = ?), 0),
           cache_read_tokens = COALESCE((SELECT SUM(cache_read_tokens) FROM session_usage_facts WHERE session_id = ?), 0),
           cache_write_tokens = COALESCE((SELECT SUM(cache_write_tokens) FROM session_usage_facts WHERE session_id = ?), 0)
         WHERE id = ?`
      )
      .bind(
        fact.sessionId,
        fact.sessionId,
        fact.sessionId,
        fact.sessionId,
        fact.sessionId,
        fact.sessionId,
        fact.sessionId
      )
      .run();

    const totals = await this.db
      .prepare(
        `SELECT total_cost, total_tokens, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens
         FROM sessions WHERE id = ?`
      )
      .bind(fact.sessionId)
      .first<SessionUsageTotalsRow>();
    if (!totals) {
      throw new Error(`Session ${fact.sessionId} was not found after recording usage`);
    }

    return {
      totalCost: totals.total_cost,
      totalTokens: totals.total_tokens,
      inputTokens: totals.input_tokens,
      outputTokens: totals.output_tokens,
      cacheReadTokens: totals.cache_read_tokens,
      cacheWriteTokens: totals.cache_write_tokens,
    };
  }
}
