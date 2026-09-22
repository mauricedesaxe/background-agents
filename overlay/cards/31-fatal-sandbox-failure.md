---
id: 31-fatal-sandbox-failure
title: A fatal sandbox failure ends the turn instead of respawning forever
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: fork commit 01de809
---

## Outcome

A deterministic sandbox boot failure is visible to the user and stops. It cannot cycle replacement
sandboxes, exhaust provider quota, hold orphaned compute, or block other sessions from spawning.

## Observable behavior

When the sandbox supervisor reports a failure as fatal (retrying is futile), the session settles
visibly with that reason, prompts still waiting on the sandbox fail with the same reason, and no
replacement sandbox spawns. A non-fatal failure keeps the existing recovery: a replacement spawns
and the prompt queue resumes. The failed sandbox is stopped or reclaimed rather than left orphaned
while it still holds provider resources.

## Durable constraints

The supervisor's fatal flag must survive error parsing; the control plane may not re-derive it from
the error string. Only non-fatal failures may respawn and resume the queue. Every fatal failure
remains visible to the user with its reason rather than disappearing into retries. This contract
bounds sandbox lifecycle failures and is separate from provider request rejections, which have their
own bound and their own evidence.
