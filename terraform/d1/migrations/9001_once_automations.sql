DROP INDEX IF EXISTS idx_automations_schedule_due;

ALTER TABLE automation_repositories
  ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

ALTER TABLE automation_runs
  ADD COLUMN prompt_content TEXT;

ALTER TABLE automation_runs
  ADD COLUMN repository_set TEXT;

CREATE INDEX idx_automations_schedule_due
  ON automations (enabled, trigger_type, next_run_at)
  WHERE enabled = 1 AND deleted_at IS NULL AND trigger_type IN ('schedule', 'once');
