---
id: 12-oneshot-popover
title: One-shot schedule-prompt popover
type: rebuild
priority: low
placement: upstream-code
depends_on: []
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

The durable, sync-surviving part is the **D1 migration** that the blind sync wipes: restore
`9001_once_automations.sql` verbatim at its original id (prod has it applied, so it skips by id; a
fresh D1 applies it). Do not renumber it and do not change its content (Rule 3).

## Priority

Low. Keep, sequence after the functional (cards 04-06) and sidebar (card 07) items. Not a blocker
for a working sync.

## Correction (2026-08-19)

An earlier draft called this a "UI rebuild on an intact upstream backend." That was wrong: upstream
has the recurring-schedule machinery but no one-shot, so the one-shot is rebuilt as the "once"
variant described above. The recon that sized it as a large from-scratch backend was also wrong for
the same reason. Both are recorded here so the next sync does not re-derive them.

## Dated evidence (2026-08-19, non-binding hints)

- The one-shot presented as a schedule-prompt popover on the main screen, backed by a "once" trigger
  the scheduler fires and then disables. The reapply agent locates the current main-screen entry
  point and the current scheduler surface itself; these are hints, not instructions.
