# Overlay rules

## Prefer durable configuration

Use deployment configuration when it survives a sync and changing it does not replace persistent
resources. Otherwise rebuild the behavior and protect it with an observable check.

## Verify each outcome

Every card has a behavior-level check that crosses the user-visible seam. Run deterministic checks
in blocking CI. Run checks that require deployed infrastructure as blocking post-deploy steps.

A broad smoke test does not prove an unrelated card. Child completion, provider rejection, context
recovery, and repository recovery each need their own evidence.

## Keep fork migrations append-only

Fork-local D1 migration IDs start at 9000. Never reuse an applied ID for new content and never
change an applied migration. Keep a fork migration after any upstream migration it depends on.

## Record both keeps and drops

Active cards state outcomes the fork keeps. Files under `drops/` state decisions the fork has
retired. Do not restore a dropped behavior without a new product decision.
