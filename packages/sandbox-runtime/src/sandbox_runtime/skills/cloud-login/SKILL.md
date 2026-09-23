---
name: cloud-login
description:
  Log into Cloudflare Wrangler or Railway from this sandbox. Use when the work involves Cloudflare,
  using Cloudflare, Workers, Pages, Durable Objects, wrangler deploy/login, railway login/up/deploy,
  Railway signup or account creation, the user will authorize OAuth, CLOUDFLARE_API_TOKEN looks set
  but wrangler fails, RAILWAY_TOKEN is missing, a localhost:8976/oauth/callback URL is pasted, or a
  Railway device-code / cli-login link appears.
---

# cloud-login

Run `oi-cloud-login`. Do not run `wrangler login` or `railway login` yourself.

## Cloudflare

1. `oi-cloud-login cloudflare start`
2. Send the printed `Open:` URL to the user immediately.
3. They click Allow. The browser fails on `localhost:8976`. Ask them to paste that full address-bar
   URL.
4. `oi-cloud-login cloudflare complete '<pasted-url>'`
5. Deploy.

If start prints `STATUS ready`, skip to deploy.

Never curl a callback URL that is not `http://localhost:8976/oauth/callback`. Never print token
values.

## Railway

1. `oi-cloud-login railway start`
2. Send the printed `Open:` URL (and `Code:`, if any) to the user immediately.
3. `oi-cloud-login railway wait`
4. Then `railway up` or other Railway CLI.

`RAILWAY_TOKEN` / `RAILWAY_API_TOKEN` skip this. Do not run `railway login` in the foreground.
