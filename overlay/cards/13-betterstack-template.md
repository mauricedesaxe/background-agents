---
id: 13-betterstack-template
title: Better Stack incident diagnosis automation
type: rebuild
priority: low
placement: upstream-code
depends_on: []
origin: fork automation template
---

## Outcome

An authenticated Better Stack incident creates exactly one agent session that can diagnose the
incident using useful alert and incident context.

## Observable behavior

A valid Better Stack incident delivery starts one diagnosis session whose prompt includes the
incident identity, status, affected resource, timing, summary, and available links or diagnostic
details. Invalid authentication starts no session. Retrying or redelivering the same incident event
does not create a duplicate session.

## Durable constraints

Authentication is verified before accepting a delivery. Repeated delivery of the same event must
create at most one session. Incident context must be sufficient for the agent to begin diagnosis
without requiring the user to restate the alert.
