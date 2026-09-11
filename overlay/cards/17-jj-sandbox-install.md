---
id: 17-jj-sandbox-install
title: jj binary installed in the sandbox image
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: fork (wiped by the blind sync)
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5342416752
---

## Requirement

The sandbox image has the `jj` (Jujutsu) binary installed and on `PATH`. This is foundational for
the harness/jj story: the sandbox agent opens its PRs through `lazar-ship`, and
`lazar-commit`/`lazar-ship` are pure jj with no git fallback (card `15-harness-install`,
`11-jj-pr-helper`). Without jj in the image, the sandbox agent errors at the first jj command and
can produce no PR.

## Acceptance test (the contract)

A built sandbox image has `jj` on `PATH` at the pinned version (`jj --version` succeeds). Behavior,
not files. There is no cheap unit test for an image-build declaration; the real verification is the
connect + a real jj-colocated push at deploy time (runbook Gate 4 plus card 11's behavior).

## Placement decision (durable)

Installed in the sandbox image build as part of its declared toolchain, pinned to a named version
and integrity-verified, reapplied each sync. Upstream has none of this — 100% fork-local. The fork
previously installed jj here; the blind sync wiped it, which is why the harness/jj story was
silently broken on clean upstream. This card restores it.

The eventual move of the jj install into the external `lazar-harness` (card 11's original placement)
still stands as a later option; until the harness installs binaries, it lives here.

## Gotchas

- **The install ships nothing without an image version bump.** Repo-wide snapshot-invalidation rule
  (#94 family): a toolchain change reaches sandboxes only when the image version moves and the
  snapshot rebuilds. The runbook's image gate covers it.
- **Pin parity with every other install lane.** The CI seam tests that exercise jj install their own
  jj (card 11); its pin and the image's pin move together.

## Provenance

First installed fork-side in the image build; wiped by an early blind sync and re-added under this
card (2026-08-19). File-level notes from the original card were dropped when the card contract went
requirements-first — locate the toolchain declaration on current upstream yourself.
