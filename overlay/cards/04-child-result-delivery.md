---
id: 04-child-result-delivery
title: Child-result delivery to the parent agent
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: upstream #24; fork commits 707f756 (closes #285), 3361bd8
---

## Outcome

A parent agent continues without user intervention when a child session finishes.

## Observable behavior

When a child enters a terminal state, its parent receives an agent-sourced message containing the
child's final response and pull-request artifacts. The parent resumes and can act on that result.

## Durable constraints

- Deliver the result only when the child transitions into a terminal state.
- A child update that does not change status must not deliver the result again.
- Do not resume or deliver results to an archived or cancelled parent.
- Record successful delivery so that retries do not produce duplicate parent messages.
