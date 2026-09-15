---
id: 12-oneshot-popover
title: One-shot schedule-prompt popover
type: rebuild
priority: low
placement: upstream-code
depends_on: []
migrations: [9001]
origin: fork UI
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5340524840
---

## Requirement

From the main screen, the user can start a prompt / new session **once, at a chosen time in the
future** (a quick "run this in N minutes/hours" action). This is distinct from recurring
automations, which exist on upstream and stay. Alex uses one-shot deferred launches regularly.

## Acceptance test (the contract)

Trigger a one-shot deferred launch for T+N -> it fires once at ~T+N -> the session launches with the
given prompt, and the automation does not fire again. Replay-safe: a redelivery does not
double-launch. A future-dated launch does not fire early, and a cancelled one does not fire.
Behavior, not files.

## Placement decision (durable)

The one-shot is a **variant of the recurring schedule automation, not a separate subsystem**. The
reapply agent extends whatever upstream's automation/scheduler surface is on the day it runs (a
"fire once, then disable" trigger) rather than standing up a parallel one-shot backend.

The durable, sync-surviving part is the **D1 migration** that the blind sync wipes: restore fork
migration 9001 verbatim at its original id (prod has it applied, so it skips by id; a fresh D1
applies it). Do not renumber it and do not change its content (Rule 3).

## Priority

Low. Keep, sequence after the functional (cards 04-06) and sidebar (card 07) items. Not a blocker
for a working sync.

## Provenance

The fork shipped the one-shot as a schedule popover on the main screen over a "once" trigger; the
blind sync wipes the UI and the migration, and both are restored each sync — the migration verbatim
at id 9001. Two corrections from 2026-08-19, kept so the next sync does not re-derive them: the
first draft called this a "UI rebuild on an intact upstream backend," which was wrong (upstream has
the recurring machinery but no one-shot), and the recon that sized it as a large from-scratch
backend was wrong for the same reason. The 2026-09-11 conversion dropped the card's remaining
entry-point hints as orientation.
