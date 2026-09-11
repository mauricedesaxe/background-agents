---
id: 13-betterstack-template
title: diagnose-betterstack-incident automation template
type: rebuild
priority: low
placement: upstream-code
depends_on: []
origin: fork automation template
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5341149831
---

## Requirement

A BetterStack incident (uptime/log alert) triggers an automation that spawns an agent to diagnose
the incident from the codebase and available signals, and reports. This complements the existing
Sentry-investigation template; this deployment uses BetterStack for logs/uptime (PHILOSOPHY §12), so
incidents originating there are actionable the same way Sentry's are.

## Acceptance test (the contract)

A signed BetterStack incident webhook arrives -> an automation whose trigger is "BetterStack
incident" fires -> an agent session launches with the diagnosis prompt and reports. An
unsigned/invalid webhook is rejected. Behavior, not files.

## Placement decision (durable)

All **code, in the upstream-owned tree, reapplied each sync.** It is more than a template entry:
upstream models triggers as a typed set (`schedule`, `github_event`, `sentry`), each first-class
with its own webhook path and signature setup. There is no BetterStack trigger, so the rebuild adds
three things, parallel to the Sentry trigger:

1. A BetterStack trigger type.
2. A signed BetterStack webhook receiver.
3. The template with its setup instructions.

The Sentry trigger is the working reference to copy, which de-risks it.

## Priority

Low. Keep, sequence after the functional, sidebar, and one-shot items. Not a blocker for a working
sync.
