ALTER TABLE sessions ADD COLUMN latest_output_message_id TEXT;
ALTER TABLE sessions ADD COLUMN latest_output_at INTEGER;

CREATE TABLE session_read_states (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  read_output_message_id TEXT,
  manually_unread INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id)
);

CREATE INDEX idx_session_read_states_session
  ON session_read_states(session_id, user_id);
