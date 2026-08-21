---
id: 24-multi-repository-automations
title: Scheduled automations run across multiple repositories
type: rebuild
priority: high
placement: upstream-code
depends_on: []
migrations: [9009]
origin: fork; multi-repository maintenance automations
---

## Requirement

A repository-independent automation can target no repository, one repository, or up to ten
repositories. Selecting several repositories defaults to fan-out. Every firing starts one
independent session per repository. Each session checks out only its assigned repository and opens
its own branch, artifacts, and pull request. The shared automation instructions apply to every child
session.

Repository-independent automations can instead select shared workspace mode. Shared workspace mode
requires two to ten direct repositories, rejects environment targets, and starts one session with
the ordered repository set. The run stores that resolved set in `automation_runs.repository_set`
before launch. Existing automations remain in fan-out mode.

Repository selections are stored as rows, not as repository fields on the automation. Each row holds
the owner, name, resolved repository id, and base branch. The server rejects duplicate normalized
repositories. It resolves an omitted base branch to the repository default when the automation
saves.

Every firing creates one invocation. Fan-out creates one child run per selected repository. Shared
workspace mode creates one child run that snapshots every resolved repository before launch. Editing
an automation affects the next firing only. History always uses run snapshots, never the
automation's live repository list.

The history status is derived from child runs. A sweep completes only when every child completes. A
sweep fails when every child fails. A mixed terminal result is `partial_failed`. A skipped firing
has no children. One inaccessible repository fails its child but does not prevent other repositories
from starting.

GitHub and Linear triggers stay single-repository because their incoming event identifies the target
repository. Other trigger types can fan out or start a shared workspace. A running invocation blocks
the next scheduled firing. Manual trigger requests return a conflict while an invocation is active.

The automation form exposes a multi-select repository picker for repository-independent automations.
With two or more direct repositories selected, it shows an explicit choice between fan-out and one
shared workspace. GitHub and Linear forms keep the single-target picker.

## Acceptance test (the contract)

Create a scheduled automation with two repositories in fan-out mode. Trigger it once. The server
records one invocation with two child runs. Each child starts a session that targets only its
assigned repository. Both child sessions receive the shared instructions. Each session can create
its own pull request.

Create a scheduled or one-shot automation with two repositories in shared workspace mode. The server
records one child run and starts one session with the ordered repository snapshot. Shared mode
rejects environment targets, non-schedule triggers, and fewer than two repositories.

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
- Restore `9009_automation_execution_mode.sql` verbatim. Once production applies it, D1 skips it by
  id. A fresh D1 applies it.
- Card `22-automations-group-by-repo` depends on this capability.

## Dated evidence (2026-08-21, non-binding hints)

- Design record: `docs/MULTI_REPO_AUTOMATIONS.md`.
- Shared contract: `packages/shared/src/types/automations.ts`.
- Persistence: `packages/control-plane/src/db/automation-store.ts`.
- Launch fan-out: `packages/control-plane/src/scheduler/durable-object.ts`.
- API validation: `packages/control-plane/src/routes/automations.ts`.
- Form and target picker: `packages/web/src/components/automations/automation-form.tsx` and
  `packages/web/src/components/automations/use-automation-targets.ts`.
