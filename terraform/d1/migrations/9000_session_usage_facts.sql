-- Forward-only per-step usage facts. Analytics before this migration's
-- deployment date are incomplete because earlier usage was stored only as a
-- mutable session cost total.
CREATE TABLE session_usage_facts (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  cost_estimate REAL NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, event_id)
);

CREATE INDEX idx_session_usage_facts_observed_at
  ON session_usage_facts(observed_at);

ALTER TABLE sessions ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN usage_cost_baseline REAL NOT NULL DEFAULT 0;

UPDATE sessions SET usage_cost_baseline = total_cost;
