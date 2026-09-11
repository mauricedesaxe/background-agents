---
id: 26-beads-sandbox-install
title: bd (Beads) present and usable in the sandbox image
type: rebuild
priority: high
placement: upstream-code
depends_on:
  - 15-harness-install
origin: fork (install lived image-side, discovered uncarded in the 2026-09-11 pre-sync audit)
---

## Requirement

A fresh sandbox from the built image ships the `bd` (Beads) CLI at a pinned version, on `PATH`, with
integrity verification. Beads is the durable task graph for standing multi-session programs: the
graph lives in the repository's own git refs, so it survives every sandbox dying.

Presence alone is not the requirement. An agent in the sandbox must be able to run the full loop on
a repository that already carries a bead graph on its origin: adopt the graph (bootstrap, pull,
prime), read it, mutate it, and persist it (commit, push) — using the repository's normal git
credentials, with no extra auth or setup steps. On a repository that does not carry a graph, the
agent must not create one unless the user asks. That gate is policy, and it lives in the installed
harness's coordination playbook (external repo, card 15), not in this card.

Felt outcome: a program coordinator and its successors can reconcile from the graph and continue
after any sandbox death, without a human re-briefing them.

## Acceptance test (the contract)

1. In a fresh sandbox from the built image, `bd --version` prints the pinned version.
2. Seeded round trip, in a fresh sandbox: against a repository whose origin carries a bead graph,
   adopt (bootstrap, pull, prime) succeeds; create a bead; commit and push it; then, from a second
   fresh sandbox, pull and see that bead. This crosses the seam — it proves the binary, the local
   database lifecycle, and the git credential path all work together. It needs a seeded repository,
   so it runs as a blocking runbook check (or a test with a recorded fixture), not a unit test.
3. The installed harness carries the Beads usage policy — when to adopt a graph, the
   never-init-unasked gate, and the sole-writer rule — such that an agent reading its own
   instructions follows the gate unprompted.

## Placement decision (durable)

The binary is part of the built sandbox image: declared in the image build's toolchain, pinned to a
named version and checksum-verified, reapplied each sync. It is deliberately **not** a lazar-harness
install: the image owns its tooling, and the harness intentionally installs no binaries. Upstream
has none of this — 100% fork-local.

Durable constraints:

- The pin upgrades only by decision, recorded here. Pin at time of writing: `bd` **1.2.2**
  (checksum-verified release tarball from the beads GitHub releases).
- The bead graph stays in the repository's git refs. It never moves into the platform's databases —
  that boundary is what makes program state survive the platform.

## Gotchas

- **Moving the install ships nothing without an image version bump.** This is the repo-wide
  snapshot-invalidation rule (#94 family): a change to the toolchain reaches sandboxes only when the
  image version moves and the snapshot rebuilds. The runbook's image gate covers it.
- **Pin parity with any other install lane.** If CI or another environment installs `bd` for tests,
  its pin must match this one. (None exists today; stated so the first one inherits the rule.)

## Provenance

The `bd` install has lived fork-side in the image build since the Daytona bake. It was never carded:
this card was written on 2026-09-11, during the pre-sync audit, after finding the fork 272 commits
behind with the next blind sync due — the sync would have wiped `bd` from the image with nothing to
restore it. Upstream had reorganized the dependency-install area in the meantime (#1816), so any
file-level notes captured before that reorganization were left out on purpose.
