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

Trigger a one-shot deferred launch for T+N -> the scheduler fires it at ~T+N -> the session launches
with the given prompt. Replay-safe: a redelivery does not double-launch. Behavior, not files.

## Placement decision (durable)

A **UI-and-wiring rebuild on top of an existing backend**, in the upstream-owned tree, reapplied
each sync. The one-shot scheduling backend is intact on upstream (replay-safe one-shot launches are
verified there), so this is not a backend rebuild — lower risk than a full-stack feature.

## Priority

Lower than the functional (cards 04-06) and sidebar (card 07) items. Keep, sequence after them.

## Dated evidence (2026-08-19, non-binding hints)

- On the pre-sync fork the UI was a ~150-line popover component plus a mount on the main app page.
  On clean upstream the component does not exist and must be rebuilt, and the mount re-added. The
  reapply agent locates the current main-screen entry point and the current scheduler interface
  itself.
