---
id: 05-provider-stall
title: Provider failure / stall surfacing and bounding
type: rebuild
priority: medium
placement: upstream-code
depends_on: [06-sandbox-connect]
origin: upstream #25; fork commits 647303c (A), bfac2fc + 4e9376c (B, reference only)
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5339876793
---

## Requirement

Two parts, decided separately.

**Part A — surface the stall (locked).** When the provider is retrying (usage limit, rejection), the
timeline shows it: an explicit provider-retrying indication with the attempt count and the next
attempt time. Pure visibility, no behavior change. High value for a background-agent product, where
a usage-limit stall currently looks identical to a session that is thinking.

**Part B — bound the retry (locked).** The agent must NOT retry a rejected provider request forever.
On a structural failure it stops after **at most a few minutes** and surfaces the failure. No
multi-day silent retry.

## Acceptance test (the contract)

- Part A: the provider emits a retry status -> the web timeline shows that the provider is retrying,
  with the attempt count and the next attempt time.
- Part B: a persistently rejected prompt stops within a few minutes and surfaces the failure; it
  does not retry indefinitely. A legitimately slow-but-live operation is NOT false-killed.

## Placement decision (durable)

Rebuilt in the **upstream-owned tree**, reapplied each sync. Part A crosses the bridge -> shared
protocol -> web timeline; carry its original tests across. Depends on card `06-sandbox-connect`
(same connect and streaming path); sequence after it.

## How Part B is bounded (decided): an attempt cap, not a silence deadline

Bound the retry by **counting the provider's explicit rejections** and stopping after a small cap,
then surfacing the failure. The cap keys off the same reject signal Part A surfaces, so it never
fires on silence — a slow-but-live turn with no rejections is never killed.

Do NOT rebuild the fork's shape (a no-message "progress" deadline): it kills a legitimately slow
operation with no output, and it was calibrated against a fork-only compaction bound that clean
upstream lacks. The attempt cap avoids both.

## Upstream-issue candidate (deferred, not now)

The uncapped silent provider retry is a candidate to raise upstream rather than only patch here (the
retry-forever behavior is OpenCode's; the missing bounding is background-agents'). Recorded as a
candidate only. Not filing now. Same batch as the card `14-js-tests-ci` candidate.

## Provenance

Part A shipped fork-side in commit 647303c and Part B exists only as reference commits (bfac2fc,
4e9376c — deliberately not a patch to port); the blind sync wiped the fork build and both parts are
rebuilt to the decisions above each sync. The 2026-08-19 card anchored Part A to the bridge's
streaming loop of that era, dropped in the 2026-09-11 conversion. Nothing superseded: the attempt
cap over the silence deadline remains the locked design.
