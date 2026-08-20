---
id: 20-archive-always-hides
title: Archiving a session always hides it
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: fork; issue #328; sidebar cleanup — un-archivable sessions
discussion: https://github.com/mauricedesaxe/background-agents/issues/328
---

## Requirement

Archiving a session succeeds for any session the caller is authorized to archive. Archive means
"hide this from my sidebar", so no session state may block it. Two upstream guards make sessions
permanently un-archivable and must not come back:

- A **cancelled** session was refused. A cancelled session is terminal and exactly the kind of dead
  row the user wants gone.
- A session with **queued work** (any message in `pending` or `processing`) was refused. A message
  stranded in `processing` after a sandbox dies never drains, so that guard pins the session as
  un-archivable forever.

Instead, archive stops any live or wedged execution first and then transitions to `archived`, the
same way the trusted child-cascade already retires a running child. This is also what unblocks the
orphaned sub-tasks that cards `08-archive-cascade` and `19-orphan-subtask-hidden` hide on the
display side: a parent that could not be archived never fired its cascade, so its children kept
showing.

Authorization is unchanged: a missing session still 404s, a malformed body still 400s, and a caller
who is not a participant is still 403. Only the two state-based 409 guards are removed. When archive
does fail (an auth failure), the web client surfaces the server's actual reason instead of a single
generic "Failed to archive session" string, so a real failure is legible rather than looking random.

## Acceptance test (the contract)

Archiving a `cancelled` session returns success and transitions the session to `archived` without
stopping execution (nothing to stop). Archiving an active session that holds a stuck
`pending`/`processing` message returns success, stops execution first, then transitions to
`archived`. Neither path returns 409. The authorization failures (404 / 400 / 403) still hold.
Covered by control-plane lifecycle-handler tests that assert `stopExecution` and
`transition("archived")` are called for the stuck case and that `stopExecution` is skipped for the
already-terminal cancelled case. A reintroduced "queued work" or "cancelled sessions cannot be
archived" 409 reddens these tests.

## Placement decision (durable)

- Rebuilt in the **upstream-owned session Durable Object lifecycle handler** (`archive`), reapplied
  each sync. Upstream owns and actively develops this handler and its preconditions, so re-locate
  the archive method and re-remove the two state guards against whatever it looks like on the day.
  Reuse whatever stop-then-archive primitive the cascade path uses so the two stay consistent.
- **No migration.** It rides existing status and message-state reads.
- The toast-reason improvement is a small **web** change in the archive client; it is not the
  load-bearing part of the card and carries no test of its own.

## Dated evidence (2026-08-20, non-binding hints)

- `packages/control-plane/src/session/http/handlers/session-lifecycle.handler.ts`, method `archive`.
  It now mirrors `archiveCascade` in the same file:
  `if (!TERMINAL_STATUSES.has(session.status)) await deps.stopExecution({ suppressStatusReconcile: true })`,
  then `deps.statusService.transition("archived")`.
- Tests: `packages/control-plane/src/session/http/handlers/session-lifecycle.handler.test.ts`, cases
  "stops wedged execution and archives a session with stuck queued work" and "archives a cancelled
  session without stopping execution".
- Toast reason: `packages/web/src/lib/archive-session.ts` reads `error` from the failed response
  body.
