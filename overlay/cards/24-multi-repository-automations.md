---
id: 24-multi-repository-automations
title: Automations can work across multiple repositories
type: rebuild
priority: high
placement: upstream-code
depends_on: []
migrations: [9009]
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
- Restore migration `9009` verbatim. Once production applies it, D1 skips it by id. A fresh D1
  applies it.
- Card `22-automations-group-by-repo` depends on this capability.
