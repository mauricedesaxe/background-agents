---
id: do-not-rebuild
title: Product behavior this fork retired
type: drop
origin: fork decisions
---

# Do not rebuild these decisions

Restoring any item below requires a new product decision. A sync does not restore them merely
because old fork code still exists in history.

- Per-child model overrides and the zero-cap fan-out control are not part of the product.
- Manual context compaction stays removed. Automatic overflow compaction remains.
- Voice-to-text and transcription stay removed.
- The terminal-toggle state correction is not worth carrying as a fork divergence.
- The GitHub bot does not inject a Lazar review prompt.
- Slack truncation warnings and activity indicators stay removed because this deployment does not
  use Slack.
- The content-ideas automation template stays removed.
- The daily upstream-exchange ledger and templates stay removed.
- The old tldraw board and its manual deployment workflow stay removed.
- The autonomous scheduled overlay orchestrator stays removed. Overlay sync is a deliberate,
  operator-driven workflow with human review before landing.
- The fork-local authentication system stays removed. The product uses Better Auth.
- Upstream's session and duration models remain authoritative. Do not restore fork-only wrappers or
  namespace variants.
- Do not restore fork migrations 9005 or 9008. Upstream owns the replacement unread-state and
  session-index schema; the retired IDs remain reserved in deployed databases.
- Do not restore fork migration 9009. Upstream owns the equivalent automation repository model.
