---
id: 11-jj-pr-helper
title: jj in the sandbox + jj-aware PR helper
type: rebuild
priority: high
placement: lazar-harness + upstream-code
depends_on: [15-harness-install]
origin: fork; lazar-harness ref c28bc423
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5340160683
---

## Requirement

The sandbox agent works in a jj-colocated checkout and opens **non-empty** PRs. Decisive reason: the
harness's own ship flow hard-requires jj. `lazar-commit` and `lazar-ship` are pure jj with no `.jj`
detection and no git fallback, and the sandbox agent opens its PRs through `lazar-ship`. Absent jj,
they error at the first command and the flow the sandbox exists to run breaks. Two parts:

1. **jj is installed in the sandbox.**
2. **A jj-aware PR helper pushes the real work**, not an empty branch.

## Acceptance test (the contract)

Create a session in a jj-colocated repo -> the agent makes changes -> the PR helper pushes a
**non-empty** branch carrying the actual work (not an empty branch off a lagging git HEAD). This
protects fan-out (card `04-child-result-delivery`), which depends on children producing real PRs.

## Placement decision (durable)

- **The jj binary install moves into the external `lazar-harness` install script** (config-ward), so
  it leaves the upstream-owned tree and rides in with the harness. This couples to card
  `15-harness-install`; sequence after it. Removing the jj install from the upstream-owned image
  build is the point — anything in lazar-harness survives a blind sync untouched.
- **The jj-aware PR helper stays as reapplied code** in the upstream-owned tree, redone each sync.
  It fixes a problem jj creates: the control plane builds its push specs against git HEAD, but a
  jj-colocated checkout parks the git HEAD ref away from the working copy, so pushing that ref
  publishes an empty branch. The helper detects the jj checkout, targets the working-copy revision
  (or its parent), and sets the bookmark to the branch name.

## Durable constraint

An image-side harness change propagates only through the snapshot content hash (card 01's
constraint): the harness content must sit inside the hashed payload roots or it ships nothing, and
no version-stamp bump substitutes for a real hashed change. The old "bump the version stamp along
with the harness ref" recipe is superseded — see Provenance.

## Notes

- The `enforce-jj` hook is NOT the blocker — it no-ops in a plain-git repo. The read/reporting
  skills (`lazar-standup`, `lazar-pr-status`) have git fallbacks; the commit/ship path does not.
  That asymmetry is the whole reason jj is required.
- The local-workspaces benefit of jj does not apply in a sandbox (each sandbox is its own checkout).
  It was never the reason; the skills dependency is.

## Provenance

The fork built both parts; the binary install then moved into the external lazar-harness (ref
c28bc423) so it would stop being wiped, while the PR helper stayed as reapplied bridge code. The
2026-08-19 card anchored the helper to one file and line of that era's bridge and warned that a
harness-ref bump needed a version-stamp bump to rebuild the snapshot; both were dropped in the
2026-09-11 conversion — the anchor is anatomy, and the recipe is superseded by the content-hash
propagation recorded in the fork ops notes. The skills-dependency rationale stands unchanged.
