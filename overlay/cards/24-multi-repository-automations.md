---
id: 24-multi-repository-automations
title: Automations can work across multiple repositories
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: fork; multi-repository maintenance automations
---

## Requirement

A repository-independent automation can target no repository, one repository, or up to ten
repositories. When several repositories are selected, the user chooses how the automation works.

"One session per repository" runs the same instructions independently in every selected repository.
Each repository can produce its own branch and pull request.

"One shared workspace" starts one agent session with every selected repository available together.
Use it for work that crosses repository boundaries, such as a frontend and its API. It requires at
least two repositories.

The choice is visible when the user selects several repositories. Existing automations keep their
current per-repository behavior. GitHub and Linear automations stay single-repository because the
incoming event already identifies one repository.

## Acceptance test (the contract)

Create an automation with two repositories. The form offers both workspace choices.

Choose "One session per repository" and trigger it. Each repository receives an independent agent
session with the same instructions.

Choose "One shared workspace" and trigger it. One agent session starts with both repositories in its
workspace. A choice with fewer than two repositories is unavailable.

Edit an automation while it runs. The active work retains its original repository selection. The
next trigger uses the new selection.

## Placement decision (durable)

- Rebuild the capability in the upstream-owned automation product. Reapply it as one behavior.
- **No fork migration.** Never restore fork migration 9009 — upstream's own schema now carries it
  (see the Disposition). Prod skips the applied 9xxx id, but a fresh database would apply it on top
  of upstream's migration and break.
- Card `22-automations-group-by-repo` depends on this capability.

## Disposition (2026-09-11 audit vs upstream 0e9ecf98)

**MOSTLY COVERED natively.** The audit found upstream ships multi-repository automations for most of
this card's surface, so there is little or nothing to reapply — verify the acceptance behaviors on
the fresh tree rather than assuming the fork build. Fork migration 9009 must never be restored: its
content collides with upstream's migration 0030, so the applied 9xxx id would silently no-op on prod
while a fresh database applies both and breaks. The earlier "restore 9009 verbatim" instruction is
void.

One **OPEN PRODUCT CALL** is recorded: for a multi-repository automation, is the fork's explicit
"one shared workspace" choice the right model, or are upstream's environments the shared-workspace
primitive? Decision owner: Alex, tracked in #328. Until that call lands, prefer upstream's native
behavior and do not rebuild the fork's choice on top of it.
