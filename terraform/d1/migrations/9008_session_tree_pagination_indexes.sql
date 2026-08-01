CREATE INDEX IF NOT EXISTS idx_sessions_updated_at_id
  ON sessions(updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_user_updated_at_id
  ON sessions(user_id, updated_at DESC, id DESC);
