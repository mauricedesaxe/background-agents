---
id: 07-sidebar
title: Improved grouped session sidebar (items 7-10)
type: rebuild
priority: high
placement: upstream-code
depends_on: []
migrations: [9005, 9008]
origin: upstream #20, #21; fork origin 0b12c30
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5340089982
---

## Requirement

The session sidebar is grouped and usable under heavy fan-out. Upstream's flat list is inadequate
for this workflow. Four parts, one cohesive system, all non-negotiable:

- **Collapsible child-session trees** (#20). Heavy fan-out floods a flat list without it.
- **Per-repo grouping** — the structural core. Upstream only prints repo _labels_ on a flat list;
  the fork groups by repo.
- **Automatic-vs-manual separation** — sessions split by whether a human or an automation started
  them.
- **Per-user manual unread** (#21) — mark-a-session-unread, per user.

## Acceptance test (the contract)

Render the sidebar with a realistic set (multiple repos, automatic + manual, parent + children) and
assert: repo grouping, automatic/manual separation, child-tree collapse, and the unread marker all
render. Per-state render tests (this repo has no Storybook; use its view-test convention), plus unit
tests on the grouping data-model transform. This is the guardrail against a half-rebuilt sidebar.

## Placement decision (durable)

- Rebuilt in the **upstream-owned tree**, reapplied each sync.
- **Restore migrations 9005 and 9008 verbatim at their original ids** (Rule 3). The blind sync wipes
  these fork-local files, but prod has the rows applied, so prod skips them by id and a fresh D1
  (CI, a new environment) applies them. Restoring is required so the sidebar's columns/indexes exist
  off a clean tree. 9005 adds `manually_unread` (#21); 9008 adds keyset-pagination indexes for the
  child trees. 9008 is NOT a duplicate of upstream's own session indexes — it creates
  differently-named composites with `id DESC` for stable keyset pagination.
- **Keep upstream's server-paginated status sections and creator filter; layer the fork's repo
  grouping + automatic/manual separation inside them.** Do not replace the sections with a flat
  client-side grouped list — that discards the server-side pagination heavy fan-out needs. The UX
  (grouping + auto/manual + child collapse + unread) is fixed; how the grouping nests inside the
  current sections is the reapply agent's call.

## This is the highest reapply-cost line in the plan

Biggest UI surface, and upstream **actively develops this exact file** (they added a creator
filter). A blind sync overwrites it every sync, so the reapply re-lands the divergence against
changing upstream code. A half-rebuilt sidebar is precisely the silent regression that passed CI in
#327. Phase 4 implication: this line resists the hands-off ambition. Flag it for a careful/human
reapply pass, not a rubber-stamp.

## Dated evidence (2026-08-19, non-binding hints)

- Data model: `buildGroupedSessionList`, `SessionRepositoryGroup`,
  `SessionSourceFilter = "manual" | "automatic"`, `childrenMap` in
  `packages/web/src/lib/session-list.ts`.
- Component `session-sidebar.tsx`; unread reuses `read-state/route.ts`.
