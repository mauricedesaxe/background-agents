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

Installed in the **Daytona image build** (`toolchain.py`), reapplied each sync, pinned to a specific
version via a `JJ_VERSION` constant. Fetches the prebuilt musl binary from the `jj-vcs/jj` releases,
extracts to an owned tmp dir (avoids the `/tmp` sticky-bit extraction error), and installs to
`/usr/local/bin/jj`.

The fork previously installed jj here; the blind sync wiped it (100% fork-local), which is why the
harness/jj story was silently broken on clean upstream. This card restores it.

## Gotchas

- **Bump `SANDBOX_VERSION` in the same change.** The Daytona `source_hash` tracks `.py/.js/.ts`, so
  the `.py` edit invalidates the snapshot on its own, but the version string is what the snapshot is
  keyed by, so bump it to force the rebuild. (Bumped to the `-jj-` variant.)
- **Pin the same jj version in CI.** Card 11's jj-colocated seam tests install jj in the
  sandbox-runtime CI job; keep that version and this `JJ_VERSION` in step.
- The eventual move of the jj install into the external `lazar-harness` (card 11's original
  placement) still stands as a later option; until the harness installs jj, it lives here.

## Dated evidence (2026-08-19, non-binding hints)

- `packages/daytona-infra/src/toolchain.py`: `JJ_VERSION` constant + a `run_commands` step in
  `build_base_image`, next to the code-server / agent-browser installs.
