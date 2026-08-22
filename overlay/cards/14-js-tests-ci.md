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

## Acceptance test (the contract) — self-proving

CI has a job that executes the `.mjs` suites, and a deliberately-failing `.mjs` test turns CI red.
(Test-infra item, so that is its contract.)

## Placement decision (durable)

**CI config, upstream-owned, reapplied each sync.** The job **globs**
`packages/sandbox-runtime/tests/*.mjs` rather than hardcoding filenames, so after a sync it runs
whatever suites exist — robust to upstream adding or renaming files.

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
