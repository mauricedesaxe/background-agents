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
timeline shows it: a `provider_retry` event ("provider retrying, attempt N, next attempt at T").
Pure visibility, no behavior change. High value for a background-agent product, where a usage-limit
stall currently looks identical to a session that is thinking.

**Part B — bound the retry (requirement locked, implementation open).** The agent must NOT retry a
rejected provider request forever. On a structural failure it stops after **at most a few minutes**.
No multi-day silent retry.

## Acceptance test (the contract)

- Part A: the provider emits a retry status -> a `provider_retry` event reaches the web timeline.
- Part B: a persistently rejected prompt stops within a few minutes and surfaces the failure; it
  does not retry indefinitely. A legitimately slow-but-live operation is NOT false-killed.

## Placement decision (durable)

Rebuilt in the **upstream-owned tree**, reapplied each sync. Part A crosses the bridge -> shared
protocol -> web timeline; port its origin tests. Depends on card `06-sandbox-connect` (same
connect/SSE path); sequence after it.

## Implementation is open for Part B — do NOT port the fork shape as-is

The fork implementation (`bfac2fc` + `4e9376c`) is a second "progress" deadline that fails the
prompt at 10 min of no message/session events. Two problems:

1. It actively kills sessions, so a legitimately slow operation with no output for >10 min gets
   false-killed.
2. Its 10-min threshold was calibrated against a fork-specific 5-min compaction bound that does not
   appear on clean upstream, so the calibration premise may not hold.

Before rebuilding B, decide the right shape: an attempt cap on the retry itself, a shorter fail
deadline, or re-establishing the compaction bound it leaned on.

## Action — upstream issue (when convenient)

The uncapped silent provider retry is a candidate to raise upstream, not only patch here. The
retry-forever behavior is OpenCode's; the missing surfacing/bounding is background-agents'. Check
for an existing issue and decide the target repo before filing. Batch with the card `14-js-tests-ci`
upstream-issue note.

## Dated evidence (2026-08-19, non-binding hints)

- Part A origin `647303c` (~175 lines), the bridge SSE loop.
- Part B reference-only origins `bfac2fc`, `4e9376c`.
