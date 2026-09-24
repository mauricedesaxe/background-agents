---
id: 24-multi-repository-automations
title: Do not restore a second multi-repository automation model
type: drop
origin: fork; multi-repository maintenance automations
---

## Decision

Use upstream's repository and environment choices for multi-repository automations. Do not restore
the fork's separate "one shared workspace" toggle.

## Reason

Upstream already supports independent repository fan-out and shared workspaces through environments.
A second selector duplicates those concepts and makes the form harder to understand. Fork migration
9009 also conflicts with upstream's automation repository model and must not be restored.
