---
id: 28-persistent-resume-git-safety
title: Preserve unpublished repository state across sandbox restarts
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: fork issue #90 and PR #246
---

## Outcome

A sandbox restart preserves unpublished repository state on the existing filesystem.

## Observable behavior

Create a local commit, a staged change, a dirty tracked file, and an untracked file. After the
remote branch moves, restart the sandbox. The session retains the same branch, `HEAD`, index, dirty
tracked file, and untracked file. A remote refresh failure warns the user but does not replace the
sandbox or block access to the checkout.

Repeat the restart when the original boot came from a repository image and before the first prompt.
The same state survives, first-boot setup does not repeat, and restart setup still runs.

## Durable constraints

On persistent resume, startup may refresh remote references but must not check out or reset a remote
branch. First-boot setup does not run again, while restart-specific setup still runs. The rule
applies before the first prompt, across providers and agent harnesses. Explicit builds and snapshot
restores remain separate startup modes. This contract concerns repository state, not the model's
conversation context.
