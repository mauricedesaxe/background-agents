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
upstream, archiving a parent flips only the parent's status; its children stay active in the
persistent session index. The sidebar reads unarchived status from that index, so after the
optimistic client update the next inbox refetch resurrects the still-active children as orphaned
"sub-task" rows. The user sees children they explicitly meant to clear.

The cascade fires from the session status transition, gated on archiving, so it runs once per real
transition regardless of which entrypoint archived the session. Each archived child cascades to its
own children. Children are reached through a trusted internal service-to-service call that carries
no participant check — a child's participants may not include whoever archived the parent — and it
is never exposed on a public route. A running child has its execution stopped with the status
reconcile suppressed, so the archived status sticks instead of settling back to active/completed
once the current run finishes. The fan-out is best-effort per child: an unreachable or never-created
child is logged, not retried, and never fails the parent's archive.

## Acceptance test (the contract)

Parent with an active child and grandchild -> archive the parent -> parent, child, and grandchild
all reach archived in the persistent session index, and the child's own runtime state is flipped too
(not just the index). A child linked by parentage but not agent-spawned is archived as well. An
already-archived child is skipped without error. An unrelated top-level session is untouched. A
sibling still archives even when another child's runtime was never created. Covered by an
integration test through real session-to-session calls in the worker runtime, plus handler unit
tests for the trusted path (running child stops execution first, terminal child does not,
already-archived is a no-op).

## Placement decision (durable)

- Rebuilt in the **upstream-owned tree**, reapplied each sync.
- No migration. The cascade rides the existing parent linkage and the session status index; nothing
  schema-level is added.
- The load-bearing half is **server-side**. Upstream's sidebar already drops the archived root's
  whole subtree optimistically, so the visible bug is the refetch resurrecting still-active
  children. Rebuilding the server cascade is what actually fixes it; the client needs no change for
  the parent-archive case.

## Edge left open (not on this card)

Archiving a mid-tree child (not a root) drops only that node from the sidebar's optimistic update,
not its own grandchildren. The server cascade still archives them, so they leave on refetch. A
client-side subtree drop for the descendant-archive case is a small follow-up, not required for the
reported bug (archiving a parent).

## Provenance

The fork built the cascade to close #14 (commits b138ee9a and dece5c76); discussion moved to #344.
The blind sync wipes it and it is rebuilt server-side each sync. The 2026-08-19 card named the
trusted endpoint's contract constant, its route and handler files, the fan-out function, and the
integration test by path — all dropped in the 2026-09-11 conversion as anatomy. Nothing superseded:
the trusted-internal-call rule and the best-effort-per-child policy stand.
