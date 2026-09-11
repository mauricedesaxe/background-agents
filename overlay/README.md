# overlay/

This directory is the source of truth for every way this fork diverges from upstream
`ColeMurray/background-agents`. It is the one directory a sync must preserve.

## The sync contract

This repo is a tracked fork on a **blind-sync** strategy. Every 2 weeks:

1. Fetch upstream.
2. Overwrite the whole tree with upstream, **except `overlay/`**.
3. Read the cards here and rebuild each kept divergence onto the fresh upstream.
4. Run the sync runbook (below) as a blocking gate before the sync PR merges.

So the rule is: **sync means take all of upstream except `overlay/`.** Nothing outside this
directory is durable. The rebuilt feature code is disposable. It gets wiped every sync and
regenerated from these cards.

## What a card is (read this before reading any card)

Each card is a **requirement plus an acceptance test**, written from the outside. The requirement
states what must be true for the user or operator, or how a failure reproduces from the outside. The
acceptance test states what a verifier observes when it is true. It is NOT an implementation recipe,
and it must not read like one:

- **No anatomy.** A card does not name the files, functions, constants, routes, or code shapes where
  the change should land — in any section, not even as "hints". The reapply agent locates the code
  on current upstream itself. Upstream reorganizes constantly: between two syncs it consolidated the
  entire sandbox dependency-install area (#1816), which turned every file-anchored instruction in
  that area into a map of a corpse. A card that names today's file teaches the next agent to patch a
  corpse.
- **Placement is categorical, never anatomical.** The placement decision names the sync-surviving
  lane the divergence lives in, plus any durable constraints on it. It never names a path.

Dated evidence is optional provenance: a short note on where the divergence came from and what
happened to it — added fork-side, wiped by a sync, superseded by an upstream change. It is history,
not orientation. It must pass one test: could a reader mistake any of it for instructions? When in
doubt, delete it.

To rebuild a divergence:

1. Read the **requirement** (the felt outcome, or the reproduction) and the **acceptance test** (the
   observable behavior that proves it).
2. Locate the relevant code on current upstream **yourself**. Expect it in different files than any
   earlier note mentioned.
3. Implement the behavior.
4. Prove it with the acceptance test.

The **placement decision** on each card is durable. It records where sync-surviving state lives: a
snapshot the overlay owns, a gitignored tfvar, the external `lazar-harness` repo, a plan-time guard,
upstream-tree code, or CI config. That is the config / overlay / upstream boundary, which is the
whole point of the overlay. Keep it.

## Card frontmatter

```yaml
id: # kebab id, matches the filename
title: # short human title
type: # rebuild | config-verify | runbook-step | drop
priority: # high | medium | low
placement: # snapshot | gitignored-tfvar | lazar-harness | plan-time-guard | upstream-code | ci-config
depends_on: # [card ids that must land first]
migrations: # [applied 9xxx ids to REUSE, never re-add]  (omit if none)
origin: # upstream issue #, commit hashes — provenance
discussion: # link to the #328 decision comment (the mirror)
```

`type` is not just a label. It tells the sync automation what to do with the card:

- `rebuild` — re-implement the behavior in the upstream-owned tree this sync.
- `config-verify` — assert a sync-surviving config value is present, set it if missing. No code.
- `runbook-step` — a blocking check the sync agent runs live; not a rebuild and not CI.
- `drop` — a feature we deliberately do NOT rebuild, with the reason, so a requirements-first agent
  that sees value in it does not re-introduce it.

## Layout

```
overlay/
  README.md            this file — the sync contract
  rules.md             the 4 process rules every card obeys
  runbook.md           the blocking sync gate (connect check, tfvar assert, D1 check)
  orchestrator.md      the weekly-sync orchestrator playbook (Phase 4, #328)
  cards/               one card per kept divergence
  drops/               do-not-rebuild cards
```

The GitHub issue `#328` is the discussion mirror, not the source of truth. When a decision changes,
the card changes; the issue records the conversation.
