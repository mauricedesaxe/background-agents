---
id: 03-queue-name-length
title: Image-build queue name under Cloudflare's 63-char cap
type: rebuild
priority: high
placement: plan-time-guard
depends_on: []
origin: fork #329
---

## Outcome

Cloudflare queue names remain valid without changing the deployment identity.

## Observable behavior

Planning fails before any resource changes when a derived queue name exceeds Cloudflare's
**63-character limit**. Planning succeeds when every derived queue name is within the limit.

## Durable constraints

- Every derived queue name must contain at most **63 characters**.
- Enforce the limit before deployment can modify resources.
- Queue-specific naming may be shortened to satisfy the limit.
- Never rename the deployment identity to work around the queue-name limit. The identity names
  stateful resources and external targets, so changing it can destroy, orphan, or disconnect them.
