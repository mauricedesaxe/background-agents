---
id: 25-sandbox-context-recovery
title: Preserve agent context across sandbox replacement
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: upstream #997
---

## Outcome

Replacing a sandbox does not silently separate the model's conversation context from the timeline
the user sees.

## Observable behavior

After a multi-turn session establishes a decision, replace the sandbox and send a prompt that
depends on that decision. The agent either continues with the decision in context or tells the user
that the next prompt starts fresh and waits for confirmation. The same behavior applies when the
provider sandbox is missing or the local OpenCode session ID is invalid.

## Durable constraints

The durable timeline is not proof that the replacement model received prior context. Dispatch must
restore model-visible context or require an explicit fresh-context choice. This contract concerns
conversation state, not files or unpublished repository work.
