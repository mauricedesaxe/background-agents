---
id: 14-js-tests-ci
title: sandbox-runtime JS test suites run in CI
type: rebuild
priority: high
placement: ci-config
depends_on: []
origin: upstream #26
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5341284620
---

## Requirement

The sandbox-runtime JavaScript test suites (`*.test.mjs`) run in CI on every PR, and a failure
blocks merge. Today no CI job executes them, so they are dead weight even on upstream.
**Strategically load-bearing — of everything in this list, the absence of this is what let #327
happen.** This job arms the guardrail that makes every other item's JS-side seam test actually bite.

## Acceptance test (the contract) — one red run per sync

After each sync, confirm the JS job is armed: make one suite fail, watch CI go red on the PR, then
restore it. A sync that leaves the suites unexecuted reverts this card to a rebuild.

## Placement decision (durable)

**CI config, upstream-owned, reapplied each sync.** The job **globs** a glob over the
sandbox-runtime test suites rather than hardcoded filenames, so after a sync it runs whatever suites
exist — robust to upstream adding or renaming files.

## Finding that raises the stakes

Both fork and upstream write `.mjs` suites, but **neither fork nor upstream CI runs any of them** —
there is no `node --test` step in the CI workflow. So the JS-half tests never execute on either
side. This is exactly the #327 failure class: per-half tests that pass while the feature is broken.

## Upstream-issue candidate (deferred, not now)

Upstream's own `.mjs` tests never run in its CI either — arguably an upstream bug, not just a fork
gap. Restoring the job fixes it for both sides, so it is a clean thing to push upstream later.
Recorded as a candidate only. Not filing now. Same batch as the card `05-provider-stall` candidate.

## Priority

High leverage despite being "just CI config." Rebuild **early** — it protects the reapply of every
other JS-touching item.

## Disposition (2026-09-11 audit vs upstream 0e9ecf98)

**COVERED upstream.** The audit found the JS suites already run in CI on every pull request on
upstream, so the gap this card existed to close is closed at the source. Nothing to rebuild or
reapply; the card records that fact. The acceptance test above supersedes the original one (a CI job
executing the suites, self-proven by a deliberately failing test) — that is now upstream's own
state, verified once per sync by the red-run confirmation. If the job is absent after a sync, or a
red run does not block, rebuild the job; the requirement at the top is back in force.
