WITH RECURSIVE archived_subtrees(id, path) AS (
  SELECT id, '/' || hex(CAST(id AS BLOB)) || '/'
  FROM sessions
  WHERE status = 'archived'
    AND NOT EXISTS (
      SELECT 1
      FROM sessions AS parent
      WHERE parent.id = sessions.parent_session_id
        AND parent.status = 'archived'
    )

  UNION ALL

  SELECT sessions.id, archived_subtrees.path || hex(CAST(sessions.id AS BLOB)) || '/'
  FROM sessions
  JOIN archived_subtrees ON sessions.parent_session_id = archived_subtrees.id
  WHERE instr(
    archived_subtrees.path,
    '/' || hex(CAST(sessions.id AS BLOB)) || '/'
  ) = 0
)
UPDATE sessions
SET status = 'archived',
    spawn_closed = 1,
    updated_at = MAX(updated_at + 1, unixepoch() * 1000)
WHERE id IN (SELECT id FROM archived_subtrees);
