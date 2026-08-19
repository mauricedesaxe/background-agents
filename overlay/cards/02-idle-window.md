---
id: 02-idle-window
title: Idle-stop window (5 min)
type: config-verify
priority: medium
placement: gitignored-tfvar
depends_on: []
origin: fork config
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5339554515
---

## Requirement

A session sandbox stops after ~5 minutes of inactivity, so idle sessions do not burn compute. This
is a **config value to verify present**, not a feature to rebuild. No code.

## Acceptance test (the contract)

The sync gate asserts `sandbox_inactivity_timeout_ms == 300000` is set in the prod tfvars.
Behaviorally, a real idle session stops at ~5 min (verified in prod at ~5.5 min). If the tfvar is
absent, the automation sets it, it does not assume it.

## Placement decision (durable)

The 5-min window is env `SANDBOX_INACTIVITY_TIMEOUT_MS` <- tfvar
`sandbox_inactivity_timeout_ms = 300000`, in `terraform/environments/production/`, which is
**gitignored**. It is the one genuinely sync-proof config in the overlay: it is not in the repo
tree, so a blind sync cannot touch it. Env wins over the upstream code default, and the code default
equals the same value anyway, so a lost env still lands on 5 min.

Because the tfvar is local-only, a fresh machine or a lost tfvars file can drop it. So the sync
automation must **assert it as a precondition and set it if missing** (see `runbook.md`).

## Not carried

The "+5 min grace while a tab is connected" note in the original list is wrong. The code is a
hardcoded **2-minute** extension, upstream-owned, not config. We do NOT pin our own value —
upstream's default stands. Dropped as a tracked divergence.

## Dated evidence (2026-08-19, non-binding hints)

- `terraform/environments/production/terraform.tfvars` line ~21: `300000 # 5 min`.
- Code default `INACTIVITY_TIMEOUT_MS = 5*60*1000` and `INACTIVITY_EXTENSION_MS = 2*60*1000` in the
  sandbox lifecycle decisions module.
