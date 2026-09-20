---
id: 11-jj-pr-helper
title: jj-colocated work produces a non-empty PR
type: rebuild
priority: high
placement: upstream-code
depends_on: [17-jj-sandbox-install]
origin: fork; lazar-harness ref c28bc423
---

## Outcome

Work completed in a jj-colocated sandbox is published as a non-empty pull request containing the
actual changes made by the agent.

## Observable behavior

A session in a jj-colocated repository can make changes and open a pull request whose branch
contains those changes. The pull request is not an empty branch based on a stale Git HEAD.

## Durable constraints

The published branch must contain the agent's current changes rather than a stale checkout revision.
Supported non-jj checkouts must continue to work, and fan-out work must produce reviewable pull
requests with each child's real changes.
