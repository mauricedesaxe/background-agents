---
id: 24-multi-repository-automations
title: Scheduled automations run across multiple repositories
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: fork; multi-repository maintenance automations
---

## Requirement

A scheduled automation can target no repository, one repository, or up to ten repositories.
Selecting several repositories starts one independent session per repository for every firing. Each
session checks out only its assigned repository and opens its own branch, artifacts, and pull
request. The shared automation instructions apply to every child session.

This is maintenance fan-out, not atomic cross-repository work. A user who needs one agent session
with several repositories selects an environment workspace instead.

Repository selections are stored as rows, not as repository fields on the automation. Each row holds
the owner, name, resolved repository id, and base branch. The server rejects duplicate normalized
repositories. It resolves an omitted base branch to the repository default when the automation
saves.

Every firing creates one invocation. The invocation creates one child run per selected repository.
Each child snapshots its repository details before launch. Editing an automation affects the next
firing only. History always uses its child snapshots, never the automation's live repository list.

The history status is derived from child runs. A sweep completes only when every child completes. A
sweep fails when every child fails. A mixed terminal result is `partial_failed`. A skipped firing
has no children. One inaccessible repository fails its child but does not prevent other repositories
from starting.

Only scheduled and manual firings may target several repositories. Event triggers stay at zero or
one repository until their cross-repository meaning is defined. A running invocation blocks the next
scheduled firing. Manual trigger requests return a conflict while an invocation is active.

The automation form exposes a multi-select repository picker for scheduled automations. It states
the ten-target limit and that each repository starts its own session. Event forms keep the
single-target picker.

## Acceptance test (the contract)

Create a scheduled automation with two repositories. Trigger it once. The server records one
invocation with two child runs. Each child starts a session that targets only its assigned
repository. Both child sessions receive the shared instructions. Each session can create its own
pull request.

Edit the selection while the first invocation runs. Its history retains the original two repository
snapshots. The next firing uses the new selection. Make one selected repository inaccessible. Its
child fails while the other child starts. A non-schedule automation with two repositories is
rejected. The form prevents more than ten total repository and environment targets.

Cover this through real D1 storage and scheduler launch tests. Cover the form's multi-select state
and submit payload in the web test suite.

## Placement decision (durable)

- Rebuild this in the upstream-owned shared types, control-plane automation store and scheduler, API
  routes, and web automation form. Reapply it as one capability. Do not create a separate
  single-repository pipeline.
- The normalized selection table and invocation table are the source of truth. Runs are child
  records that link to sessions. Do not store an aggregate invocation status.
- Restore any required fork-local D1 migrations at their recorded 9xxx ids after they are assigned.
  The migration must support both an existing production schema and a fresh D1 database. Record the
  ids in this card before the first sync that applies them.
- Card `22-automations-group-by-repo` depends on this capability.

## Dated evidence (2026-08-21, non-binding hints)

- Design record: `docs/MULTI_REPO_AUTOMATIONS.md`.
- Shared contract: `packages/shared/src/types/automations.ts`.
- Persistence: `packages/control-plane/src/db/automation-store.ts`.
- Launch fan-out: `packages/control-plane/src/scheduler/durable-object.ts`.
- API validation: `packages/control-plane/src/routes/automations.ts`.
- Form and target picker: `packages/web/src/components/automations/automation-form.tsx` and
  `packages/web/src/components/automations/use-automation-targets.ts`.
