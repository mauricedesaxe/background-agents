---
id: 22-automations-group-by-repo
title: The automations list groups by repository
type: rebuild
priority: medium
placement: upstream-code
depends_on: []
origin: fork; issue #328; automations-page readability
discussion: https://github.com/mauricedesaxe/background-agents/issues/328
---

## Requirement

The automations list is grouped by repository instead of one flat dump. Each single-repository
automation appears under a heading naming its `owner/name`. Single-repository headings are sorted
alphabetically. Every automation that targets **more than one repository**, and every automation
with **no repository** (an environment-only target), collapses into one group labelled "Multiple
repositories" that sorts last. Order within a group is preserved from the list order the server
returned.

Grouping is presentation over the automations already loaded on the page. The list is cursor-paged
by creation time, so a repository's automations can span a "Load more" boundary; that is acceptable
at this instance's scale and is a deliberate choice, not a bug to chase into a server-side re-sort.

## Acceptance test (the contract)

The grouping is a pure function over a list of automations, tested directly: single-repository
automations are grouped under their `owner/name` key and the keys come out alphabetically; a
multi-repository automation and a repository-less automation both land in the single "Multiple
repositories" bucket, which comes last; the bucket is omitted entirely when every automation targets
exactly one repository; order within a group is preserved. The list component renders one heading
per group. Covered by a web unit test on the grouping function plus the component test asserting a
per-group heading renders. A regression that flattens the list or mis-buckets multi-repo automations
reddens the function test.

## Placement decision (durable)

- The grouping rule lives in a **fork-owned pure helper** in the web app
  (`groupAutomationsByRepository`), and the **upstream-owned** automations list component calls it
  and renders a section per group. Reapply each sync by re-locating the list component and
  re-wrapping its rows in the grouped sections; the helper itself is fork code and moves with the
  overlay.
- **No migration**, **no server change.** It reads `automation.repositories` already on every list
  item.
- Client-side, over the loaded page set (see the pagination caveat in the requirement).

## Dated evidence (2026-08-20, non-binding hints)

- Helper + test: `packages/web/src/lib/group-automations-by-repository.ts` and its `.test.ts`
  (exports `groupAutomationsByRepository`, `MULTIPLE_REPOSITORIES_GROUP_LABEL`).
- Component: `packages/web/src/components/automations/automations-list.tsx` renders a `<section>`
  with an `<h2>` heading per group and the automation rows inside each.
- Component test: `packages/web/src/components/automations/automations-list.test.tsx`, case "groups
  a single-repository automation under an owner/name heading".
