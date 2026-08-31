---
id: 15-harness-install
title: lazar-harness install into the sandbox image
type: rebuild
priority: high
placement: upstream-code + lazar-harness
depends_on: []
origin: fork
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5341478917
---

## Requirement

The sandbox coding agent runs with lazar-harness installed (skills, agents, rules, hooks — the
sandbox surface), pinned to a specific version and env-overridable via `HARNESS_REF` /
`HARNESS_REPO`. This is what makes the sandbox agent behave like the user's harness (`lazar-commit`,
`lazar-ship`, `lazar-qa`), which card `11-jj-pr-helper` hard-depends on. **Foundational** — item 11
and the whole "sandbox agent uses my harness" premise depend on it. Rebuild early; sequence before
card 11.

## Acceptance test (the contract)

A built sandbox image has the harness installed at the pinned ref (the install-harness test asserts
resolved ref == requested `HARNESS_REF`), AND the sandbox agent can invoke a `lazar-*` skill.
Behavior, not files.

## Placement decision (durable)

- The install **mechanism** is code in the upstream-owned tree (an install script + a hook in the
  image build that invokes it), reapplied each sync. Upstream has none of this — 100% fork-local.
  The mechanism is small and low-friction to reapply.
- lazar-harness itself is the **external repo**, and this card is the **config-ward escape hatch**:
  anything pushed INTO lazar-harness survives a blind sync untouched, because the upstream tree
  never sees it. The jj binary (card 11) is the first thing moving there. The more fork behavior
  that lives in lazar-harness, the less gets reapplied in the upstream tree each sync.

## Gotcha (same as cards 01, 11)

Editing `HARNESS_REF` used to be a `.sh` change that did NOT bump the Daytona `source_hash`, which
tracked `.py/.js/.ts` only, so a ref bump reached no sandbox on its own. Fixed in #94: the Daytona
and Vercel hashes now cover `*.sh` too, matching what the Modal and OpenComputer hashes already did.
A pin bump rebuilds the snapshot by itself.

## Dated evidence (2026-08-19, non-binding hints)

- Install script `packages/sandbox-runtime/src/sandbox_runtime/scripts/install-harness.sh`
  (`HARNESS_REPO`, `HARNESS_REF`), invoked by a hook in the Daytona image build.
