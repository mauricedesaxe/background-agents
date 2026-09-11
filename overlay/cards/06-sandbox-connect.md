---
id: 06-sandbox-connect
title: Sandbox runtime connect verification
type: runbook-step
priority: high
placement: overlay-runbook
depends_on: [01-daytona-sizing]
origin: fork #327 lesson
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5339984009
---

## Requirement

After every sync + deploy, a real session actually connects and responds. This is NOT a feature to
rebuild. Clean upstream already connects: the #327 break was OOM (the 1 GiB snapshot default under a
~3.6 GiB image, fixed by card `01-daytona-sizing`) plus fork-only handshake drift that clean
upstream does not have. So there is nothing to port — this card is the **connect-verification step
of the sync runbook**, a blocking live smoke check the sync agent runs.

## Acceptance test (the contract) = the blocking runbook check

1. Create a session against a known repo, send a trivial prompt.
2. Assert the session reaches **connected within 90 s** and the agent produces a **first response
   within 180 s** (not just "sandbox created"). These are generous blocking bounds — they catch
   "never connects / OOM respawn", not micro-latency. Tune only if a healthy prod session ever
   legitimately exceeds them.
3. Assert idle-stop fires **4-7 min** later (card `02-idle-window`: a 5-min window, with a possible
   2-min grace period while a tab is connected).
4. On any failure: the sync is NOT good. Block the PR / roll back. Do not proceed.

## Placement decision (durable)

A **blocking runbook step, not a CI test.** The connect path _is_ the overlay — snapshot sizing
(card 01), the bridge SSE loop (cards 05, 06), the handshake — and it changes almost entirely at
sync time when the agent reapplies it. So the risk window and the verification window line up: one
live check right after reapply + deploy covers cards 01, 04, 05, and the connect concern, which
makes a per-PR CI guardrail redundant.

This is a deliberate, conscious relaxation of Rule 2's "automated seam test per divergence." A
runbook step is weaker — it leans on the sync agent running it and reading the result. So the
instruction is concrete and blocking, never "verify it connects." The check lives self-contained in
`runbook.md`.

## Escalation path

Start as the agent-run smoke step. Promote to an automated post-deploy smoke test later if the agent
proves unreliable at it, or if a between-sync regression to the connect path ever bites.
