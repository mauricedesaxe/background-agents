-- Fork-local: manual unread markers on top of upstream's read-state table (0055).
-- Upstream's session_read_states tracks the last-read cursor; the fork adds a
-- manual marker that survives auto-clear so a participant can pin a session as
-- unread regardless of the latest-output projection.
ALTER TABLE session_read_states ADD COLUMN manually_unread INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sessions ADD COLUMN latest_output_message_id TEXT;
ALTER TABLE sessions ADD COLUMN latest_output_at INTEGER;
