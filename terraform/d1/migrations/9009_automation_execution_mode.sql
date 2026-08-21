ALTER TABLE automations
  ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'fanout'
  CHECK (execution_mode IN ('fanout', 'shared_workspace'));
