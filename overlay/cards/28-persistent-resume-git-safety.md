---
id: 28-persistent-resume-git-safety
title: Preserve unpublished repository state across sandbox restarts
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: fork issue #90 and PR #246
discussion: https://github.com/mauricedesaxe/background-agents/issues/328
---

## Requirement

When a provider restarts a sandbox against its existing filesystem, repository startup must preserve
the current branch, local commits, the index, dirty tracked files, and untracked files. Startup may
refresh remote references, but it must not check out or reset the remote branch. The rule applies
before the first agent prompt and to every supported agent harness.

## Acceptance test (the contract)

Start a session, then create a local commit, a staged file, a dirty tracked file, and an untracked
file. Restart the sandbox after the remote branch moves. The session starts successfully with the
same branch, HEAD, index, dirty file, and untracked file. Repeat with the first boot starting from a
repository image. Setup hooks do not rerun, start hooks receive a persistent-resume boot mode, and a
remote refresh failure warns without replacing the sandbox or blocking access to its existing
checkout.

## Placement decision (durable)

Rebuild in the **upstream-owned tree**, reapplied each sync. Restart detection belongs to the
sandbox runtime because the surviving filesystem is the authority for whether repository state
already exists. Keep the detection independent of the provider and the agent harness. Explicit build
and snapshot-restore modes retain precedence.

## Dated evidence (2026-09-18, non-binding hints)

- Fork issue #90 confirmed that a Daytona stop and start reruns the supervisor against the retained
  filesystem and can discard unpublished work.
- Fork PR #246 fixed the behavior in August 2026.
- Blind-sync PR #378 removed the fix because no overlay card recorded the requirement.
