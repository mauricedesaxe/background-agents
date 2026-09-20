---
id: 02-idle-window
title: Idle-stop window (5 min)
type: config-verify
priority: medium
placement: deployment-config
depends_on: []
origin: fork config
---

## Outcome

Inactive session sandboxes stop so that abandoned sessions do not consume compute.

## Observable behavior

A session with no connected client stops about **five minutes** after its last activity. A connected
client receives a warning and another idle check after a **five-minute grace period**.

## Durable constraints

- The default idle window is **five minutes** at every configuration layer.
- A deployment may override the idle window.
- A missing override must fall back to **five minutes**.
- Connected clients must not be treated as fully idle.
