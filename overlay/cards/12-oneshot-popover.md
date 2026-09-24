---
id: 12-oneshot-popover
title: Complete one-shot automation lifecycle
type: rebuild
priority: low
placement: upstream-code
depends_on: []
migrations: [9001]
origin: fork UI
---

## Outcome

A user can schedule a prompt to run once at a chosen future time and can understand or control that
automation throughout its lifecycle.

## Observable behavior

The one-shot automation never fires before its scheduled time, fires at most once across retries or
duplicate delivery, and starts one session with the configured prompt when due. The user can cancel
it before it fires, and a cancelled automation starts no session. After a run settles successfully,
one-shot automations with completed or skipped outcomes disappear from the actionable list. Failed,
running, and not-yet-fired one-shot automations remain visible so the user can act on them.

## Durable constraints

One-shot execution must remain replay-safe and cancellable. Hiding settled successful one-shots must
not hide failures, in-progress work, pending work, or recurring automations, and must preserve
correct pagination of the actionable list. Migration 9001 retains its original identifier and
content.
