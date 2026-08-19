---
id: 04-child-result-delivery
title: Child-result delivery to the parent agent
type: rebuild
priority: high
placement: upstream-code
depends_on: [06-sandbox-connect]
origin: upstream #24; fork commits 707f756 (closes #285), 3361bd8
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5339757387
---

## Requirement

When a fanned-out child session reaches a terminal state, the parent agent is woken with the child's
summary so it can continue on its own. Fan-out is used heavily. On upstream, a terminal child only
broadcasts a UI refresh and never wakes the parent, so the child's summary sits unused and the user
must prompt the parent by hand. The feature fetches the finished child's summary (final response +
PR artifacts), enqueues an **agent-sourced** prompt into the parent, and lets the existing message
queue resume the parent sandbox and dispatch it. Archived and cancelled parents are left alone.

## Acceptance test (the contract)

Parent spawns child -> child goes terminal -> the parent receives an agent-sourced prompt containing
the child's summary and the parent sandbox resumes. A non-status update on the child (e.g. a title
change) does NOT re-enqueue (edge-trigger: only status transitions fire delivery).

## Placement decision (durable)

- Rebuilt in the **upstream-owned tree**, reapplied each sync, ported onto upstream's
  `parentSessions` shape (we do NOT reintroduce a fork-local `sessions` DO namespace — see the
  drops).
- Depends on card `06-sandbox-connect`: the only real prerequisite is children reaching terminal
  with a summary, which is the connect path. Sequence after it.

## Scope note

Upstream already ships the summary builder (the expensive half). Missing is only the delivery
wiring: on a terminal child status update, fetch the summary, enqueue an agent-sourced prompt, wake
the parent, plus a `deliverResult` status field and the edge-trigger guard. Roughly 100-150 lines on
existing machinery, not a full-stack rebuild.

## Reliability (upstream baseline is sound)

- A child inherits the parent's non-default branch on upstream (upstream test covers it), so the
  fork-era "children clone base branch, lose parent work" concern looks handled on the clean
  baseline.
- The jj detached-HEAD no-op is fork-only and returns only with card `11-jj-pr-helper`; it is that
  card's test burden, not this one's.

## Dated evidence (2026-08-19, non-binding hints)

- Delivery wiring lived in `child-result-prompt.ts` + ~54 lines in `durable-object.ts`.
- Summary builder already upstream as `child-session-summary.ts`.
- Tests to port onto the upstream shape: `child-result-prompt.test.ts`,
  `child-sessions.handler.test.ts`.
