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
**non-empty** branch carrying the actual work (not an empty branch off a lagging `HEAD`). This
protects fan-out (card `04-child-result-delivery`), which depends on children producing real PRs.

## Placement decision (durable)

- **jj binary install moves into the external `lazar-harness` `install.sh`** (config-ward), so it
  leaves the upstream-owned tree and rides in with the harness. This couples to card
  `15-harness-install`; sequence after it. Removing the jj block from the upstream-owned image build
  is the point — anything in lazar-harness survives a blind sync untouched.
- **The jj-aware PR helper stays as reapplied code** in the upstream-owned tree, redone each sync.
  It fixes a problem jj creates: the control plane builds specs against git `HEAD`, but a
  jj-colocated checkout pins `.git/HEAD` to `@-`, so pushing `HEAD` publishes an empty branch. The
  helper detects `.jj`, picks `@` or `@-`, and sets the bookmark to the branch name.

## Gotcha

A `HARNESS_REF` bump alone will not rebuild the Daytona snapshot (`source_hash` tracks `.py/.js/.ts`
only), so moving the jj binary in via the harness needs a `SANDBOX_VERSION` bump too. Reapply and
version bump travel together (same as cards 01, 15).

## Notes

- The `enforce-jj` hook is NOT the blocker — it no-ops in a plain-git repo. The read/reporting
  skills (`lazar-standup`, `lazar-pr-status`) have git fallbacks; the commit/ship path does not.
  That asymmetry is the whole reason jj is required.
- The local-workspaces benefit of jj does not apply in a sandbox (each sandbox is its own checkout).
  It was never the reason; the skills dependency is.

## Dated evidence (2026-08-19, non-binding hints)

- PR helper lived as `bridge.py` code (~line 2079). Do not assume it stays in one file or co-located
  with the connect/provider logic at reapply time.
