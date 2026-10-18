---
{
  "version": 1,
  "kind": "facts",
  "task": "deploy-repair",
  "created": "2026-10-18T10:33:44.994Z"
}
---

# Observed facts

Record each observation with an ID, source, time, conditions and limits. Keep explanations in hypotheses.md.

- F1. 2026-10-18, production Terraform run 39118918291 failed at D1 migration 0081 on duplicate input_tokens and at the DLQ rename on its 66-character name. Source is the saved failed-run log, /tmp/background-agents-deploy-failure.log.
- F2. Wrangler whoami verified alex@leetsoftware.com, account 16e6c46b13c47f7cfef67e8639acdecd. D1 list verified database 62c10db2-38f5-4665-aee0-efccef19cf43 is open-inspect-openinspect-leetsoftware in that account.
- F3. Live PRAGMA table_info(sessions) shows input_tokens, output_tokens, cache_read_tokens and cache_write_tokens already INTEGER NOT NULL DEFAULT 0. reasoning_tokens is absent. Ledger contains exact upstream filenames through 0080 plus legacy 9000-9009. Source /tmp/background-agents-live-schema.json. Historical 9000_session_usage_facts.sql added the four existing columns.
- F4. Rebuilt actual live sqlite_schema in scratch SQLite. Original 0081 fails with duplicate column name: input_tokens. Adding reasoning_tokens and treating 0081 as complete allows unchanged migrations 0082 through 0088 to execute successfully.
- F5. Existing queue 773f743e5f144a15a421dac67a50063e is named open-inspect-image-build-dlq-openinspect-leetsoftware. Retain it to avoid renaming resources. Source Wrangler queues list.
- F6. Before repair, captured D1 Time Travel bookmark 00000360-0000000e-00005108-cd6c1e8f15aab321b43a420ba49f4e4b. Source /tmp/background-agents-rollback.json.
- F7. Independent schema reviewer rebuilt the captured schema with foreign keys enabled, replayed the repair and 0082-0088, then verified integrity_check=ok and zero foreign_key_check violations. No blockers.
- F8. Applied ALTER reasoning_tokens and INSERT 0081 as one atomic D1 file operation. Post-read confirms all five expected token columns and the exact 0081 ledger entry. Before and after both have 4,228 sessions, 1,091,103,125 input tokens and 26,789,721 output tokens. Wrangler's --file --json emits progress before JSON; direct SQL re-read, not parsing that mixed output, verified success.
- F9. Worker ran Terraform regression before/after. Before restoring deployed DLQ name, test failed; after the one-line name restoration, test passed. terraform fmt -check passed on both changed Terraform files.
