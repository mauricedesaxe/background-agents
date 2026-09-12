---
id: 02-idle-window
title: Idle-stop window (5 min)
type: config-verify
priority: medium
placement: tracked-default-and-secret
depends_on: []
origin: fork config
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5339554515
---

## Requirement

A session sandbox stops after ~5 minutes of inactivity, so idle sessions do not burn compute. This
is a **config value to verify present**, not a feature to rebuild. No code.

## Acceptance test (the contract)

The deployed control plane carries the five-minute idle window end to end: the Terraform plan and
apply both wire the configured value through to the sandbox lifecycle, and both fall back to five
minutes when the override secret is absent. A real idle session with no connected client stops about
five minutes after its last activity. With a browser client connected, the stop is deferred by an
additional client-connected grace window (see the runbook's connect check for the current bounds).

## Placement decision (durable)

The idle window is a single configured value with a five-minute default at every layer: the
Terraform default, the CI fallback, and the worker default all agree. A deployment can override the
value with a GitHub secret. No fork-owned state carries it — the verification is that the plumbing
survived the sync and the default is what a real idle session experiences.

## Provenance

The value has been fork config since the first fork deploy; the card verifies rather than rebuilds.
The 2026-08-19 card carried line anchors into the tfvars file and the lifecycle module, dropped in
the 2026-09-11 conversion. Its "not carried" correction — that the client grace was a hardcoded two
minutes, not five — is superseded by the 2026-09-11 audit: current upstream grants a
client-connected grace, and the runbook's connect check now encodes the five-minute window plus that
grace. The "+5 min grace while a tab is connected" note in the original divergence list was wrong in
the other direction and was never carried.
