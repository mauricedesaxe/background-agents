---
id: 16-web-custom-domain
title: Web worker keeps its custom domain across deploys
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: fork #330
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5338222942
---

## Requirement

The web app keeps its custom domain after every deploy. The web worker deploys via
`wrangler deploy`, which reconciles the worker's custom domains to its generated wrangler config and
**prunes any custom domain not declared there**. With the domain managed only by a terraform
`cloudflare_workers_custom_domain` resource, every web deploy dropped it: the site fell to NXDOMAIN,
and briefly served a cert without the hostname SAN (the browser "connection can be breached"
warning). Upstream does not declare the domain, so a blind sync drops this fix every sync and the
next deploy takes the site dark.

## Acceptance test (the contract)

Run a full deploy of the web worker and assert the custom domain stays attached the whole time (it
resolves, and the served cert carries the hostname SAN) — not just immediately after the terraform
apply, but after the `wrangler deploy` step that prunes. Verified in prod by watching a full CI
apply keep the domain attached throughout.

## Placement decision (durable)

The fix is a **`custom_domain` route declared in the generated wrangler config** so wrangler
preserves it instead of pruning it. The config generation is upstream-owned, so this is a reapply
into the upstream tree each sync. The domain **value** can ride in a gitignored tfvar
(sync-surviving); the **declaration that wrangler manages the domain at all** is the code that gets
overwritten and must be reapplied.

Do NOT "fix" this by `terraform import`-ing the domain — that was tried and made it worse by
removing terraform's self-healing. The config-first declaration is the fix.

## Note

This never went through the original keep/drop grilling pass — it was found in the incident comment
after the 15-item list was written. It is kept on the same silent-failure logic as card
`03-queue-name-length`: a dropped reapply breaks prod quietly after the next deploy.

## Dated evidence (2026-08-19, non-binding hints)

- Root cause from the Cloudflare audit log: `wrangler deploy` pruning a domain absent from
  `wrangler.production.toml`.
- Fix shipped as fork #330.
