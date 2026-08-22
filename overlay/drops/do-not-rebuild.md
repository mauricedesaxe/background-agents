---
id: do-not-rebuild
title: Dropped features — do not rebuild
type: drop
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5341555577
---

# Do not rebuild these

A requirements-first reapply agent that sees value in one of these will otherwise re-introduce it.
Each is dropped on purpose. If you think one is worth having, that is a new decision for Alex, not a
reapply.

## Explicit drops

- **Per-child model override + zero-cap-disables-fanout** (#5) — not wanted.
- **Manual context compaction** (#6) — upstream keeps _automatic_ overflow compaction (verified
  intact); only the _manual_ trigger is dropped. Confirmed comfortable losing manual control.
- **Voice-to-text / transcription** (#17) — dropped. Note: this had _recent_ active fork work (the
  last several commits touch microphone streams). Dropping it is deliberate, not an oversight.
- **Terminal-toggle functional state updater** (#18) — trivial correctness nit, not worth carrying.
- **github-bot sources lazar-review prompt** (#1) — dropped.
- **slack-bot page-cap `truncated` warning** — Slack unused.

## Intended reconstruction drops (confirmed stay dropped)

- **Branded epoch/duration types** (#10).
- **`content-ideas` automation template** (#13).
- **`SessionStatusService` DO namespace named `sessions`** (#14) — upstream's `parentSessions` is
  fine, and card `04-child-result-delivery` targets `parentSessions`.
- **Daily upstream-exchange durable ledger + templates** (#22).
- **Fork-local auth surface** (#27) — converged on Better Auth; reverting would undo the D1 auth
  cutover.
