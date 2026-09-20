---
id: 16-web-custom-domain
title: Web worker keeps its custom domain across deploys
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: fork #330
---

## Outcome

The public web endpoint keeps its custom domain through a full deployment.

## Observable behavior

After the web worker deploy completes, the custom hostname resolves in DNS, completes TLS with a
certificate valid for that hostname, and returns a successful HTTP response from the web app.

## Durable constraints

Verification must run after the worker deployment, not only after infrastructure provisioning. A
deployment must not require an operator to reattach or repair the public endpoint.
