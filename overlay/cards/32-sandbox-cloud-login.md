---
id: 32-sandbox-cloud-login
title: Sandbox agents can complete Cloudflare and Railway login
type: rebuild
priority: high
placement: sandbox-image
depends_on: []
origin: fork
---

## Outcome

An agent in a fresh sandbox can log the user into Cloudflare Wrangler and Railway without being
taught the OAuth dance each session.

## Observable behavior

A fresh sandbox has a login helper on PATH and agent guidance that discovers both Cloudflare and
Railway login intents. Placeholder Cloudflare credentials in the environment do not block OAuth. For
Cloudflare, the helper prints the authorize URL immediately; after the user pastes the local
callback URL, login completes. For Railway, the helper prints the sign-in URL (and device code, if
any) immediately, then waits until login succeeds. A callback URL that is not the local OAuth
listener is rejected. Image smoke and unit tests fail if the helper or guidance is missing.

## Durable constraints

The helper and guidance reach fresh sandboxes through the sandbox image's content-hash rebuild path.
Placeholder secrets must never be treated as valid credentials. The helper must not complete a
non-local OAuth callback. A Railway sign-in URL must be shown before the login process times out;
foreground buffering that hides the link until expiry is forbidden.
