---
id: 30-prompt-readiness-gating
title: Prompts wait for a ready runtime instead of running without context
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: fork commit 3d71a76
---

## Outcome

A prompt sent while the session runtime is not ready is preserved and delivered once the runtime is
ready. It is never lost, never silently discarded, and never executed against a runtime that lacks
the session's context.

## Observable behavior

Send a prompt while the sandbox is starting, restarting, or reconnecting. The prompt stays visibly
queued and is delivered to the agent only after the runtime reports itself ready. Held prompts
deliver in order after recovery, including across a client disconnect and reconnect. A prompt is
never handed to an agent runtime that has not reported ready for the session.

## Durable constraints

The gate keys on the runtime's own readiness report, not on whether a client is connected. Held
prompts survive disconnection and delivery retries without duplication or loss. A gate that never
releases is a failure: once the runtime reports ready, held prompts must flow. A sandbox that is
captured mid-snapshot still counts as deliverable rather than blocking prompts.
