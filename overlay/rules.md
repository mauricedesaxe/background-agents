# Process rules

Every card obeys these four. They are the invariants; the cards are the instances.

## Rule 1 — Config-first, where a sync-surviving lever exists

Put the durable value **where a blind sync cannot reach it**: a gitignored tfvar, the external
lazar-harness repo, or a snapshot the overlay owns. Not merely "use a config variable."

Two hard limits the cards exposed:

- Sometimes there is **no config lever** — card `01-daytona-sizing` (sizing must be baked into the
  snapshot in code; the settings UI is structurally inert on Daytona, vendor-confirmed).
- Sometimes the config **is** the state and changing it is destructive — card `03-queue-name-length`
  (`deployment_name` is the suffix on every stateful resource).
- Config _plumbing_ in an upstream-owned file does not survive the sync even when the value moves to
  a tfvar.

So: prefer config where a genuine, non-destructive, sync-surviving lever exists; where it does not,
code plus a loud test. A default, not an absolute.

## Rule 2 — Acceptance test per divergence

(a) The test is **behavior-level and crosses the seam** — never per-half-only. That is the whole
#327 lesson.

(b) It runs **in CI where deterministic, as a blocking runbook step where it needs live infra.**
Card `06-sandbox-connect` makes the connect test a runbook step (real sandbox required); card
`14-js-tests-ci` makes the JS suites actually run in CI.

Hard dependency: Rule 2 is not satisfied until **card 14** arms the JS test job. A seam test CI
never executes is theater.

## Rule 3 — D1 migrations append-only, reserved 9xxx

Non-negotiable. Confirmed live: 9005 + 9008 already applied in prod.

- Rebuilds **reuse** existing applied migrations. Never re-add a 9xxx id (already-recorded ids are
  skipped with no content check, so a re-add silently no-ops). Never change the content of an
  applied id.
- A migration that depends on an upstream one sits **after** it in the `MIGRATIONS` array. Id is
  identity; execution is array order.

## Rule 4 — The overlay carries both keeps and drops

Written requirements-first per the governing note in `README.md` (file refs are dated evidence). The
overlay holds:

- The keep-cards (requirement + acceptance test + placement decision).
- The **do-not-rebuild** cards in `drops/`, with reasons. A requirements-first reapply agent that
  sees value in a dropped feature would otherwise re-introduce it.
