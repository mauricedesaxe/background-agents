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

A `terraform apply` never aborts mid-run on a Cloudflare queue-name overflow. Cloudflare caps queue
names at 63 characters. Upstream derives the image-build queue names from a fixed literal prefix
plus the deployment-name suffix, and this deployment's name (24 characters) is long enough to push
the derived name past the cap. A dropped reapply surfaces only when apply hits the cap **mid-run** —
a partial apply, the exact #327 failure. Two parts:

1. Shorten the queue literal so the derived name fits.
2. A plan-time guard that fails `plan`/`validate` if any derived queue name exceeds 63 chars.

## Acceptance test (the contract)

`terraform validate`/`plan` fails **before any resource is touched** when a derived queue name would
exceed 63 chars, and passes when all fit. The real protection (no partial apply) does not depend on
remembering the reapply — a dropped literal fix is caught at plan, not mid-apply.

## Placement decision (durable)

- The length guard lives in a **fork-only tf file the overlay preserves** (a `check` block or
  variable `validation`), so it survives the sync as overlay-owned config, not upstream code. The
  gate must be known at plan time; it is never allowed to depend on a human remembering the literal
  fix.
- The shortened literal is a reapply into the upstream-owned tf, redone each sync because upstream
  keeps shipping the long name.
- **The deployment name stays untouched.** It is the suffix on every stateful resource (D1, R2, the
  control-plane, web, and bot workers, KV), with no destroy protection. Renaming it forces
  destroy-and-recreate of all of them: D1 wiped (accounts, environments, encrypted secrets, session
  index), session Durable Objects orphaned, the media bucket orphaned, and the GitHub App webhook
  target (which carries the suffix on a bot worker) forced to change. Zero benefit versus the
  literal fix.

## Notes

- Only the **web** worker has a custom domain. The other workers are on platform subdomains carrying
  the deployment-name suffix, so a rename would also break the GitHub App webhook target.
- Secrets survive a hypothetical migration regardless — the encryption material is a static
  deployment variable, not derived from the deployment name — but that does not make the rename
  worth it.

## Provenance

Found 2026-08-19 when upstream shipped the image-build dead-letter queue, which did not exist in the
pre-sync overlay tree, so the fix was reconnoitred against the clean-upstream baseline from the
start. The 2026-08-19 card named the upstream queue literal and its tf file; dropped in the
2026-09-11 conversion as anatomy. Wiped by every blind sync and restored in two halves since: the
shortened literal back into upstream's tf, the plan-time guard from the overlay-preserved file.
Nothing superseded.
