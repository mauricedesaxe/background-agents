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

The web app keeps its custom domain after every deploy. The web worker's deploy step reconciles the
worker's custom domains against its generated deploy config and **prunes any custom domain not
declared there**. With the domain managed only by a terraform custom-domain resource, every web
deploy dropped it: the site fell to NXDOMAIN, and briefly served a cert without the hostname SAN
(the browser "connection can be breached" warning). Upstream does not declare the domain, so a blind
sync drops this fix every sync and the next deploy takes the site dark.

## Acceptance test (the contract)

Run a full deploy of the web worker and assert the custom domain stays attached the whole time (it
resolves, and the served cert carries the hostname SAN) — not just immediately after the terraform
apply, but after the worker deploy step that prunes. Verified in prod by watching a full CI apply
keep the domain attached throughout.

## Placement decision (durable)

The fix is a **custom-domain declaration in the generated worker deploy config**, so the deploy tool
preserves the domain instead of pruning it. The config generation is upstream-owned, so this is a
reapply into the upstream tree each sync. The domain **value** can ride in a gitignored tfvar
(sync-surviving); the **declaration that the deploy tool manages the domain at all** is the code
that gets overwritten and must be reapplied.

Do NOT "fix" this by `terraform import`-ing the domain — that was tried and made it worse by
removing terraform's self-healing. The config-first declaration is the fix.

## Provenance

Found in the incident comment after the original 15-item list was written, so it never went through
the keep/drop grilling pass; it was kept on the same silent-failure logic as card
`03-queue-name-length` — a dropped reapply breaks prod quietly after the next deploy. Root cause was
read from the Cloudflare audit log (the deploy step pruning a domain absent from the generated
config), and the fix shipped as fork #330. The 2026-08-19 card named the generated config file;
dropped in the 2026-09-11 conversion as anatomy. Nothing superseded.
