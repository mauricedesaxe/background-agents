---
id: 23-archive-authz-canonical
title: The owner can archive bot- and automation-rooted sessions
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: fork; issue #328; sidebar cleanup — 403 on agent/automation sessions
discussion: https://github.com/mauricedesaxe/background-agents/issues/328
---

## Requirement

The single-tenant owner can archive (and unarchive, and rename) any session they can see in the
dashboard, including sessions created by a bot or an automation and the children an agent spawns
under them. The DO lifecycle authorization must accept the caller when their id matches a
participant by **either** identity column:

- A session created by a bot actor (github/linear/slack), or by an automation that a bot created, or
  spawned as a child under either, stores the **namespaced actor id** (`slack:U…`, `github:123`) in
  the participant's `user_id`, and the human's **canonical `users.id`** in `canonical_user_id`.
- A web human always arrives as the canonical id, so a `user_id`-only participant lookup misses and
  the DO returns `403 "Not authorized to archive this session"` — the owner cannot clear their own
  agent/automation sessions from the sidebar.

The fix is that the authorization lookup matches `user_id = ? OR canonical_user_id = ?`. A genuine
non-participant (an id matching neither column) is still rejected with 403, so the boundary is not
widened beyond the one tenant. This mirrors the single-tenant visibility boundary that already lets
the owner _see_ these sessions (`session-index` `getVisibleForUser` ignores the user).

This authorization change is scoped to the three lifecycle checks (archive, unarchive, updateTitle).
The WebSocket-token path keeps the `user_id`-only lookup on purpose, because a miss there
**creates** a member participant, and widening it would change token/participant issuance rather
than just authorization.

## Acceptance test (the contract)

A session whose owner participant has `user_id = "slack:U0123"` and `canonical_user_id = "canon-1"`
is archivable by the caller `"canon-1"` (200, status `archived`). A stranger whose id matches
neither column is still rejected (403). Covered by an integration test through the real Durable
Object SQLite, alongside the existing non-participant-403 case which must keep passing. A regression
that reverts the lookup to `user_id` only reddens the canonical case.

## Placement decision (durable)

- Rebuilt in the **upstream-owned participant repository** (a lookup matching both identity columns)
  and wired into the **DO lifecycle handler** so archive/unarchive/updateTitle authorize through it.
  Re-locate both on each sync; upstream owns them.
- **No migration.** The `participants` table is DO SQLite (not D1), and both columns already exist.
- Leave the WebSocket-token handler on the `user_id`-only lookup (it creates a participant on a
  miss); only the lifecycle authorization uses the canonical-aware lookup.

## Dated evidence (2026-08-20, non-binding hints)

- `packages/control-plane/src/session/participant-repository.ts`:
  `getParticipantByUserIdOrCanonical` (`WHERE user_id = ? OR canonical_user_id = ?`), plus
  `getByUserIdOrCanonical` in `participant-service.ts`.
- Wiring: `packages/control-plane/src/session/durable-object.ts`, the `sessionLifecycleHandler`
  getter passes `getParticipantForAuth` = `participantService.getByUserIdOrCanonical`. The lifecycle
  handler's auth dependency is named `getParticipantForAuth` (distinct from the ws-token handler's
  `getParticipantByUserId`, which stays `user_id`-only) so the canonical-aware semantics are legible
  at the 403 decision, not just in a repository comment.
- Tests: `packages/control-plane/src/session/participant-repository.test.ts` (both-column lookup)
  and `packages/control-plane/test/integration/session-lifecycle.test.ts`, case "archive authorizes
  the canonical user of a bot-rooted session".
