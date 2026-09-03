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

Terraform Plan and Apply pass `SANDBOX_INACTIVITY_TIMEOUT_MS` into `sandbox_inactivity_timeout_ms`.
Both jobs use `300000` when the secret is absent. A real idle session stops at about 5 minutes when
no client is connected.

## Placement decision (durable)

The worker reads `SANDBOX_INACTIVITY_TIMEOUT_MS` from the Terraform variable
`sandbox_inactivity_timeout_ms`. The Terraform default, the CI fallback, and the worker default are
all `300000`. A deployment can override that value with the GitHub secret.

## Not carried

The "+5 min grace while a tab is connected" note in the original list is wrong. The code grants one
hardcoded **2-minute** grace period. Its deadline is the last activity plus the timeout and the
grace period. The shared lifecycle manager owns this behavior.

## Dated evidence (2026-08-19, non-binding hints)

- `terraform/environments/production/terraform.tfvars` line ~21: `300000 # 5 min`.
- Code defaults `timeoutMs = 5*60*1000` and `connectedClientGraceMs = 2*60*1000` in the sandbox
  lifecycle decisions module.
