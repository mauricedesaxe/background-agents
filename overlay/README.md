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

Each card is a **product requirement plus an acceptance test**. It is NOT an implementation recipe.
The reapply agent derives the implementation from the requirement and the test, against whatever
upstream looks like on the day it runs.

File paths, function names, and line numbers in a card are **dated evidence** captured on the day
the card was written. They orient you to where the behavior lived then. They are **non-binding**.
Upstream renames, moves, splits, and refactors files. A card that says "the change lives in
`bridge.py`" is wrong the day upstream splits `bridge.py`, and stale instructions are worse than
none.

To rebuild a divergence:

1. Read the **requirement** (the felt outcome) and the **acceptance test** (the behavior that proves
   it).
2. Locate the relevant code on current upstream **yourself**. Expect it in different files than the
   card names.
3. Implement the behavior.
4. Prove it with the acceptance test. A named file that no longer exists is normal, not an error.

The **placement decision** on each card is the one durable part that is not dated evidence. It
records where sync-surviving state lives: a snapshot the overlay owns, a gitignored tfvar, the
external `lazar-harness` repo, a plan-time guard, upstream-tree code, or CI config. That is the
config / overlay / upstream boundary, which is the whole point of the overlay. Keep it.

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
  cards/               one card per kept divergence
  drops/               do-not-rebuild cards
```

The GitHub issue `#328` is the discussion mirror, not the source of truth. When a decision changes,
the card changes; the issue records the conversation.
