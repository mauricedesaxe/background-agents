---
id: 08-archive-cascade
title: Archive cascade to child sessions
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: fork commits b138ee9a (closes #14), dece5c76; original issue #14
discussion: https://github.com/mauricedesaxe/background-agents/issues/344
---

## Requirement

Archiving a session archives its child/sub-task sessions too, recursively, so the whole subtree
leaves the sidebar. Fan-out is used heavily, so a parent commonly has children and grandchildren. On
upstream, archiving a parent flips only the parent's status; its children stay `active` in the D1
index. The sidebar reads unarchived status from that index, so after the optimistic client update
the next inbox refetch resurrects the still-active children as orphaned "sub-task" rows. The user
sees children they explicitly meant to clear.

The cascade fires from the session status transition, gated on `archived`, so it runs once per real
transition regardless of which entrypoint archived the session. Each archived child cascades to its
own children. Children are reached through a trusted DO-to-DO endpoint (`/internal/archive-cascade`)
with no participant check, since a child's participants may not include whoever archived the parent;
it is never wired to a public proxy route. A running child has its execution stopped with the status
reconcile suppressed, so the archived status sticks instead of settling back to active/completed
once the current run finishes. The fan-out is best-effort per child: an unreachable or never-created
child DO is logged, not retried, and never fails the parent's archive.

## Acceptance test (the contract)

Parent with an active child and grandchild -> archive the parent -> parent, child, and grandchild
all reach `archived` in the D1 index, and the child DO's own status is flipped too (not just the
index). A child linked by `parent_session_id` but not agent-spawned is archived as well. An
already-archived child is skipped without error. An unrelated top-level session is untouched. A
sibling still archives even when another child's DO was never created. Covered by an integration
test through real SessionDO-to-SessionDO calls in workerd, plus handler unit tests for the trusted
endpoint (running child stops execution first, terminal child does not, already-archived is a
no-op).

## Placement decision (durable)

- Rebuilt in the **upstream-owned tree**, reapplied each sync.
- No migration. The cascade rides the existing `parent_session_id` column and the session status
  index; nothing schema-level is added.
- The load-bearing half is **server-side**. Upstream's sidebar already drops the archived root's
  whole subtree optimistically, so the visible bug is the refetch resurrecting still-active
  children. Rebuilding the server cascade is what actually fixes it; the client needs no change for
  the parent-archive case.

## Dated evidence (2026-08-19, non-binding hints)

- Endpoint constant `archiveCascade` in `session/contracts.ts`; route in `session/http/routes.ts`;
  DO handler `archiveCascade` in `session/http/handlers/session-lifecycle.handler.ts` (needs a
  `stopExecution` dep wired from the DO).
- Fan-out `cascadeArchiveToChildren`, gated on `status === "archived"` in
  `session/session-status-service.ts`, reaches children via `SessionIndexStore.listByParent`.
- Test: `test/integration/archive-cascade.test.ts`.

## Edge left open (not on this card)

Archiving a mid-tree child (not a root) drops only that node from the sidebar's optimistic update,
not its own grandchildren. The server cascade still archives them, so they leave on refetch. A
client-side subtree drop for the descendant-archive case is a small follow-up, not required for the
reported bug (archiving a parent).
