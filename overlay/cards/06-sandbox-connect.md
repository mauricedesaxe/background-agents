---
id: 06-sandbox-connect
title: Sandbox runtime connect verification
type: runbook-step
priority: high
placement: runbook
depends_on: [01-daytona-sizing]
origin: fork #327 lesson
---

## Outcome

Each deployment proves that a real sandbox session can connect and answer a prompt.

## Observable behavior

The deployment check creates a session against a known repository and sends a trivial prompt. The
session connects within **240 seconds** and produces its first response within **180 seconds**.

## Durable constraints

- Run the check against the deployed system after each sync and deployment.
- Treat sandbox creation without a runtime connection as a failure.
- Treat a connection without a first response as a failure.
- A failed check blocks acceptance of the deployment.
- This check verifies only connection and first-response behavior.
