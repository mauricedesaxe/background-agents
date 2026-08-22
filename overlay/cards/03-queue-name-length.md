---
id: 03-queue-name-length
title: Image-build queue name under Cloudflare's 63-char cap
type: rebuild
priority: high
placement: plan-time-guard
depends_on: []
origin: fork #329
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5339691275
---

## Requirement

A `terraform apply` never aborts mid-run on a Cloudflare queue-name overflow. Upstream's image-build
DLQ name is a 42-char literal prefix plus `-${name_suffix}`. Our `deployment_name`
("openinspect-leetsoftware", 24 chars) pushes the derived name to 66 chars, three over Cloudflare's
63-char cap. A dropped reapply makes apply hit a 400 **mid-run** — a partial apply, the exact #327
failure. Two parts:

1. Shorten the queue literal so the derived name fits.
2. A plan-time guard that fails `plan`/`validate` if any derived queue name exceeds 63 chars.

## Acceptance test (the contract)

`terraform validate`/`plan` fails **before any resource is touched** when a derived queue name would
exceed 63 chars, and passes when all fit. The real protection (no partial apply) does not depend on
remembering the reapply — a dropped literal fix is caught at plan, not mid-apply.

## Placement decision (durable)

- The length guard lives in a **fork-only tf file the overlay preserves** (a `check` block or
  variable `validation`), so it survives the sync as overlay-owned config, not upstream code.
- The shortened literal is a reapply into the upstream-owned tf, redone each sync because upstream
  keeps shipping the long name.
- **`deployment_name` stays untouched.** It is the suffix on every stateful resource (D1, R2,
  control-plane + web + bot workers, KV), with no `prevent_destroy`. Renaming it forces
  destroy-and-recreate of all of them: D1 wiped (accounts, environments, encrypted secrets, session
  index), session Durable Objects orphaned, R2 media bucket orphaned, and the GitHub App webhook URL
  (which carries the suffix on the bot worker) forced to change. Zero benefit versus the literal
  fix.

## Notes

- Only the **web** worker has a custom domain. github-bot and control-plane are on `*.workers.dev`
  with the deployment_name suffix, so a rename would also break the GitHub App webhook target.
- Secrets survive a hypothetical migration regardless (`token_encryption_key` is a static tfvar, not
  deployment_name-derived), but that does not make the rename worth it.

## Dated evidence (2026-08-19, non-binding hints)

- Upstream literal `open-inspect-image-build-finalization-dlq-${name_suffix}` in
  `terraform/environments/production/workers-control-plane.tf`.
- The queue does not exist in the pre-sync overlay tree (newer upstream feature), so the fix targets
  the clean-upstream baseline.
