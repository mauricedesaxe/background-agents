---
id: 21-automations-hide-settled-once
title: The automations list hides a settled one-shot
type: rebuild
priority: medium
placement: upstream-code
depends_on: []
origin: fork; issue #328; automations-page readability
discussion: https://github.com/mauricedesaxe/background-agents/issues/328
---

## Requirement

The automations list does not show a one-shot (`once` trigger) automation once its run has settled
without error. A one-shot that ran and finished is noise: it is already disabled and will never run
again. So a `once` automation whose latest invocation derived to `completed` or `skipped` is dropped
from the list. Everything else stays:

- A `once` automation whose run **errored** (`failed` or `partial_failed`) stays visible, and stays
  deletable, so the user can see it went wrong and remove it.
- A `once` automation that is still **in progress** (`starting` / `running`) stays visible.
- A `once` automation that has **never fired** stays visible.
- Every **non-`once`** trigger (schedule, github_event, and the rest) is untouched.

The exclusion is applied in the list **query**, not in the client, so cursor pagination stays
correct: a client-side filter over a fixed page size would return pages that render as empty once
the settled one-shots are removed.

## Acceptance test (the contract)

Against the real automations store: a `once` automation with a `completed` run is absent from
`list()`; a `once` automation with a `failed` run is present; a `once` automation with no run is
present; a `schedule` automation is present. Covered by an integration test through the real D1
query. A regression that stops excluding settled one-shots (or that also hides errored ones) reddens
it.

## Placement decision (durable)

- Rebuilt in the **upstream-owned automation store** `list()` query, reapplied each sync. Upstream
  owns and develops this store; re-locate `list()` and re-add the exclusion condition against
  whatever the query looks like on the day. Reuse the store's own derived-invocation-status SQL (the
  one aggregated over an invocation's child runs) so "settled without error" stays defined in
  exactly one place.
- **No migration.** It rides the existing `automations`, `automation_invocations`, and
  `automation_runs` tables.
- Server-side only, for the pagination reason above.

## Dated evidence (2026-08-20, non-binding hints)

- `packages/control-plane/src/db/automation-store.ts`: constant `HIDE_SETTLED_ONCE_SQL`, added to
  the `conditions` array in `list()`. It reuses `DERIVED_INVOCATION_STATUS_SQL` and excludes a
  `once` automation that has an invocation whose derived status is in `('completed', 'skipped')`.
- Test: `packages/control-plane/test/integration/automation-store.test.ts`, case "hides a settled
  one-shot but keeps a failed, pending, or non-once automation".
