-- Upstream owns migration identifiers below 9000.

CREATE TABLE IF NOT EXISTS upstream_exchange_scans (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  automation_run_id TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  source_repository TEXT NOT NULL,
  from_sha TEXT,
  to_sha TEXT NOT NULL,
  fork_head_sha TEXT NOT NULL,
  upstream_head_sha TEXT NOT NULL,
  merge_base_sha TEXT NOT NULL,
  expected_commit_shas TEXT NOT NULL,
  report_channel_id TEXT,
  report_message_ts TEXT,
  report_permalink TEXT,
  report_delivered_at INTEGER,
  finalized_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE,
  FOREIGN KEY (automation_run_id) REFERENCES automation_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_upstream_exchange_scans_cursor
  ON upstream_exchange_scans (
    automation_id,
    direction,
    source_repository,
    finalized_at DESC
  )
  WHERE finalized_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS upstream_exchange_dispositions (
  automation_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  source_repository TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN (
    'candidate',
    'intentional_divergence',
    'deployment_specific',
    'already_upstream',
    'not_useful_upstream',
    'present',
    'not_applicable',
    'divergence_conflict',
    'clean_candidate',
    'needs_decision'
  )),
  evidence TEXT NOT NULL,
  affected_packages TEXT NOT NULL,
  terraform_impact TEXT NOT NULL,
  migration_impact TEXT NOT NULL,
  divergence_entries TEXT NOT NULL,
  test_hand_merge INTEGER NOT NULL CHECK (test_hand_merge IN (0, 1)),
  semantic_port_evidence TEXT NOT NULL,
  useful_unit TEXT CHECK (useful_unit IN ('idea', 'bug_report', 'test_case', 'implementation')),
  proposed_artifact TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (automation_id, direction, source_repository, commit_sha),
  FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE
);

-- These stable rows are the two live instances for this single-tenant fork.
-- The templates remain the editable/reusable form presented in the gallery.
INSERT OR IGNORE INTO automations (
  id,
  name,
  instructions,
  trigger_type,
  schedule_cron,
  schedule_tz,
  model,
  reasoning_effort,
  enabled,
  next_run_at,
  consecutive_failures,
  created_by,
  user_id,
  created_at,
  updated_at,
  deleted_at,
  event_type,
  trigger_config,
  trigger_auth_data
)
VALUES (
  'fork-upstream-exchange-outbound',
  'Daily outbound upstream exchange',
  'Produce the daily outbound exchange report for mauricedesaxe/background-agents. This is classification and reporting only. Never write to ColeMurray/background-agents or modify the working tree. Do not create or edit issues, comments, branches, commits, pull requests, releases, or settings in either repository. Read docs/FORK.md. Fetch current upstream main from https://github.com/ColeMurray/background-agents.git into refs/remotes/upstream/main and deepen the shallow clone until the fork head, upstream head, durable cursor, and merge base are available. Call upstream-exchange action=cursor with direction=outbound and sourceRepository=mauricedesaxe/background-agents. If there is no cursor, examine merge-base..fork-head. Otherwise examine cursor..fork-head. Verify ancestry. Call action=begin with the exact ordered commit SHA list, fromSha (null only when no cursor exists), toSha=fork head, both heads, and merge base. Keep scanId and classifiedCommitShas. Classify each commit absent from classifiedCommitShas with action=classify as candidate, intentional_divergence, deployment_specific, already_upstream, or not_useful_upstream. Never recreate an existing durable disposition. For candidates set usefulUnit to idea, bug_report, test_case, or implementation. Set usefulUnit=null for exclusions and proposedArtifact=null for every outbound disposition. Record evidence, affected packages, Terraform and migration impact, docs/FORK.md entries, test hand-merge requirements, and semantic-port evidence. Post one digest to #upstream-exchange with links, rationale, explicit exclusions, and the examined range. A no-op day still gets a short report. Pass the scan ID as scan_id to slack-notify. Stop only after every expected commit is classified and Slack returns ok=true.',
  'schedule',
  '0 8 * * *',
  'UTC',
  'openai/gpt-5.6-sol',
  'high',
  1,
  CAST(strftime('%s', 'now', 'start of day', '+1 day', '+8 hours') AS INTEGER) * 1000,
  0,
  '28998786',
  NULL,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  NULL,
  NULL,
  NULL,
  NULL
);

INSERT OR IGNORE INTO automations (
  id,
  name,
  instructions,
  trigger_type,
  schedule_cron,
  schedule_tz,
  model,
  reasoning_effort,
  enabled,
  next_run_at,
  consecutive_failures,
  created_by,
  user_id,
  created_at,
  updated_at,
  deleted_at,
  event_type,
  trigger_config,
  trigger_auth_data
)
VALUES (
  'fork-upstream-exchange-inbound',
  'Daily inbound upstream exchange',
  'Produce the daily inbound exchange report from ColeMurray/background-agents into mauricedesaxe/background-agents. This is classification and reporting only. Never modify the working tree. Do not create or edit issues, comments, branches, commits, pull requests, releases, or settings. Never merge. Read docs/FORK.md. Fetch current upstream main from https://github.com/ColeMurray/background-agents.git into refs/remotes/upstream/main and deepen the shallow clone until the fork head, upstream head, durable cursor, and merge base are available. Call upstream-exchange action=cursor with direction=inbound and sourceRepository=ColeMurray/background-agents. If there is no cursor, examine merge-base..upstream-head. Otherwise examine cursor..upstream-head. Verify ancestry. Call action=begin with the exact ordered commit SHA list, fromSha (null only when no cursor exists), toSha=upstream head, both heads, and merge base. Keep scanId and classifiedCommitShas. Classify each commit absent from classifiedCommitShas with action=classify as present, not_applicable, divergence_conflict, clean_candidate, or needs_decision. Never recreate an existing durable disposition. Set usefulUnit=null. Set proposedArtifact to a short human follow-up description when local work is proposed, otherwise null. Record evidence, affected packages, Terraform and migration impact, docs/FORK.md entries, test hand-merge requirements, and semantic-port evidence. Preserve every intentional divergence. Test files must be hand-merged. Upstream migrations retain upstream IDs, fork-local migrations use 9000+, and package contract changes include Terraform review. Post one digest to #upstream-exchange with the examined range, evidence links, candidates, decisions, conflicts, and grouped exclusions. A no-op day still gets a short report. Pass the scan ID as scan_id to slack-notify. Stop only after every expected commit is classified and Slack returns ok=true. A human creates or updates any local issue after reading the digest.',
  'schedule',
  '0 9 * * *',
  'UTC',
  'openai/gpt-5.6-sol',
  'high',
  1,
  CAST(strftime('%s', 'now', 'start of day', '+1 day', '+9 hours') AS INTEGER) * 1000,
  0,
  '28998786',
  NULL,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  NULL,
  NULL,
  NULL,
  NULL
);

INSERT OR IGNORE INTO automation_repositories (
  automation_id,
  position,
  repo_owner,
  repo_name,
  repo_id,
  base_branch,
  created_at,
  updated_at
)
VALUES
  (
    'fork-upstream-exchange-outbound',
    0,
    'mauricedesaxe',
    'background-agents',
    1297529801,
    'main',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'fork-upstream-exchange-inbound',
    0,
    'mauricedesaxe',
    'background-agents',
    1297529801,
    'main',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  );
