---
id: 25-sandbox-context-recovery
title: Preserve agent context across sandbox replacement
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: upstream #997
discussion: https://github.com/mauricedesaxe/background-agents/issues/328
---

## Requirement

When a session's sandbox is replaced, the agent must not silently lose the conversation that remains
visible in the timeline. The replacement either restores model-visible prior context before it
dispatches the next prompt, or tells the user that the next prompt starts a fresh context and waits
for that choice. A stale OpenCode session ID has the same requirement.

## Acceptance test (the contract)

Complete a multi-turn session that establishes a decision. Replace its sandbox, then send a prompt
that depends on that decision. The agent continues with the decision, or the product blocks dispatch
until it clearly presents the fresh-context state. Cover a missing provider sandbox and an invalid
local OpenCode session ID.

## Placement decision (durable)

Rebuild in the **upstream-owned tree**, reapplied each sync. The control plane owns the durable
timeline and the recovery decision. The sandbox bridge owns its OpenCode-session handoff. The
implementation may restore an OpenCode session, rebuild context, or present an explicit reset, but
it must keep the browser timeline and model context from silently diverging.

## Dated evidence (2026-08-24, non-binding hints)

- Upstream issue #997: https://github.com/ColeMurray/background-agents/issues/997
- Daytona persistent resume covers `stopped` and `stale` states. A `failed` sandbox or missing
  provider object starts fresh.
- The bridge clears an invalid sandbox-local OpenCode session ID and creates a new empty session on
  the next prompt.
