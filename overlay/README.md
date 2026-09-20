# Overlay contracts

This directory is the durable source of truth for the product behavior this fork keeps when it syncs
from `ColeMurray/background-agents`. A sync starts from upstream and restores `overlay/` before
rebuilding the active cards.

Nothing outside this directory is authoritative merely because it exists in the current tree.
Current code is evidence that a card has been implemented, not a recipe for the next sync.

## Cards describe outcomes

Each active card answers three questions:

1. What does the user or operator gain?
2. What can a verifier observe when the outcome works?
3. Which constraints must survive even if upstream reorganizes the implementation?

A card never names a file, function, route, query, component, or current code shape. It does not
prescribe how to rebuild the behavior. The sync agent locates the relevant implementation on the
current upstream tree.

Keep constraints that protect the outcome across implementations. Data safety, authorization,
idempotency, ordering, provider limits, deployed state, and published product thresholds are common
examples. Delete dated implementation notes once they stop explaining a durable decision.

Every active card contains exactly these sections:

- `Outcome`
- `Observable behavior`
- `Durable constraints`

Run `python overlay/check_cards.py` before a sync or after changing a card.

## Card metadata

```yaml
id: # kebab id that matches the filename
title: # short outcome-oriented title
type: # rebuild | config-verify | runbook-step
priority: # high | medium | low
placement: # one category listed below
depends_on: # active card ids that must be satisfied first
migrations: # optional applied fork migration ids
origin: # short provenance pointer
```

Allowed placement categories are:

- `deployment-config`
- `ci-config`
- `managed-skills`
- `plan-time-guard`
- `runbook`
- `sandbox-image`
- `snapshot`
- `upstream-code`
- `upstream-doc`

`rebuild` restores behavior that upstream does not provide. `config-verify` confirms a durable
deployment setting. `runbook-step` is a live operational check rather than an implementation task.

Migration IDs are deployed-state commitments. Reuse an existing ID and its exact content when its
schema remains required; never renumber or rewrite an applied migration.

## Retired decisions

Files under `drops/` record behavior that must not be rebuilt. A retired decision states what was
dropped and why. It does not retain an implementation recipe or an acceptance test for behavior the
product no longer wants.

## Sync procedure

Use `runbook.md` for the sync and verification sequence. Use `rules.md` for the policies that apply
to every card.
