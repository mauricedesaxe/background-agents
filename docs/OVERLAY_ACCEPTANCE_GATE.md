# Overlay acceptance gate

This is the bar a reconstructed overlay or a whole-upstream sync must clear before it can be
promoted. It answers #266: what exact automated and human evidence must pass, how each piece of it
is produced, and who signs it off. Everything below is checkable against artifacts this repo already
produces. Nothing here invents a tool or a gate that does not exist.

A promotion either passes every gate in this document, or it does not ship. There is no partial
promotion and no "close enough" reading of a threshold. The gates fall into three authorizing
classes: **blocking** (CI, fully automated, a red check stops the PR), **human judgment** (evidence
is produced automatically but a person decides it is sufficient), and **human run** (a person has to
execute the step, because it reaches production and no automation does). Each section names its
class up front.

The full-autonomy posture in [SYNC_METHOD.md](SYNC_METHOD.md) reclassifies the two human classes for
the upstream-sync workflow. "Human run" and "human judgment" steps become automated: the step's
evidence is produced and scored against its threshold unattended, and a step that fails or cannot be
resolved deterministically moves the run to `manual-intervention` and pages a human. The blocking
class (sections 1-3) is unchanged, and ordinary non-sync PRs keep the human classes as written.

The evidence below is the same evidence #273 had to fake with "existing CI passes". #273 documented
this gap: it ran a probe against CI as a stand-in because no gate existed to name what was actually
required. This document closes that gap so #267, #269, and #273 can cite it instead of improvising.
The overhead source is #263; the probe write-up is
[#273's evidence comment](https://github.com/mauricedesaxe/background-agents/issues/273#issuecomment-5221520405),
and the bridge measurement is
[#291's evidence comment](https://github.com/mauricedesaxe/background-agents/issues/291#issuecomment-5224806472).

## How to read this

Each gate is a named evidence category with four fields: **what** proves it, **how** it is produced
(the exact CI job, test, Terraform step, or manual action), **threshold** (the number or condition
that counts as passing), and **who** authorizes it. A promotion checklist lives at the bottom. Work
the checklist top to bottom; a failure anywhere below the line that says "human judgment begins"
pulls a human in, and never ships on its own.

## 1. Deterministic CI: green is non-negotiable

**Class: blocking (automated).**

**What.** Every job in `.github/workflows/ci.yml` passes on the promotion PR. That is the full
checked surface: lint and Prettier for TypeScript, `tsc` typecheck across all TS packages, the web
production build, Ruff lint and format for both Python packages, control-plane unit tests, the
control-plane integration suite (which runs under `workerd`/Miniflare against a real D1 instance
with migrations applied), the web unit and Playwright browser suites, all three bot packages, the
sandbox-runtime pytest suite (which installs a real `jj` and exercises the push tests against a real
colocated checkout), the sandbox-runtime JS `node --test` suite, and modal-infra pytest.

**How.** These are the `test-*`, `lint-*`, `typecheck-*`, and `build-web` jobs in
[`ci.yml`](https://github.com/mauricedesaxe/background-agents/blob/main/.github/workflows/ci.yml),
run on every push and PR to `main`. CI is the only place this is measured; a locally green checkout
is not evidence, because the fork rules in
[`AGENTS.md`](https://github.com/mauricedesaxe/background-agents/blob/main/AGENTS.md) exist because
local runs lie.

**Threshold.** All required checks report success on the promotion PR's head commit. The two `mypy`
jobs run with `continue-on-error`, so they do not count as either a pass or a block on their own.

**Who.** Automated. A red check blocks merge with no human override, because per the git-hygiene
rule a PR that reports itself green while a check failed has shipped nothing that was verified.

## 2. Retained behavior tests: the fork's behavior is still pinned

**Class: blocking (automated), with a human signal on edit.**

**What.** Every fork-local test that pins a retained divergence from upstream still passes. The rule
from [`docs/FORK.md`](docs/FORK.md) is the load-bearing one: **test files are merged by hand, never
taken wholesale.** If a port needs one of our tests edited to go green, that edit is a signal the
port dropped a behavior, not a stale test to update.

The retained behaviors most likely to be exercised by an overlay are the ones tests already pin: the
7-minute idle window, the pending-message watchdog, unreconciled stops, session reattachment and
fail-closed resume, the archive cascade, child model inheritance, the event pump and OOM cause, the
jj-aware PR helper, and the Slack thread-truncation warning, which is pinned in
`packages/slack-bot/src/index.test.ts`.

**How.** The same `test-*` jobs in section 1. The overlay's diff must show whatever test edits it
makes, and each edit must carry a reason that beats the FORK.md entry it touches. See
`packages/sandbox-runtime/tests/test_bridge_session_reattach.py`,
`packages/control-plane/test/integration/websocket-sandbox.test.ts`, and
`packages/github-bot/test/webhook-forward.test.ts` as the homes of the pinned behavior.

**Threshold.** Zero fork tests replaced by upstream's; zero fork tests edited without a written
reason; all retained-behavior tests green.

**Who.** Automated for the pass/fail. Human judgment on every test-file edit a port proposes, and
that judgment lands on the PR as a review comment before merge, not after.

## 3. Local-fix regressions: kept regression guards still hold

**Class: blocking (automated), with a human signal on guard-list edits.**

**What.** The regression guards that exist only because nothing upstream pins them still pass. These
are distinct from retained-behavior tests: they overlap with upstream's current behavior but are not
covered upstream, so they are the canary for a future upstream change. The run-again example in
FORK.md is the author-name resolution guard, which upstream fixed the same way but still does not
pin, so it stays as a guard.

**How.** Identical to sections 1 and 2: they run inside the same `test-*` jobs.

**Threshold.** Green, and the guard list is not silently trimmed. Removing a guard that still passes
green loses the canary with no conflict.

**Who.** Automated for the pass/fail. Human judgment that the guard list is not silently trimmed,
and that judgment lands on the PR as a review comment before merge, not after.

## 4. Migration upgrade and rollback matrix

**Class: human judgment, run against an automated matrix.**

**What.** A matrix that proves every schema migration in the overlay both upgrades and rolls back
against a store at the pre-sync schema. Two stores are load-bearing, and they are not the same:

- **D1 (session index)**: `terraform/d1/migrations/*.sql`, applied by the D1 migration runner.
- **Session Durable Object**: `packages/control-plane/src/session/schema.ts`, applied by
  `applyMigrations()`, keyed by integer id, executed in literal `MIGRATIONS` array order with no
  sort and no content check.

Both are covered by the fork rule in FORK.md: fork-local session-schema migrations use ids from
`FORK_MIGRATION_ID_FLOOR` (9000) up, upstream owns everything below, and a migration that depends on
an upstream one must sit after it in the array. The D1 side follows the same 9000+ reservation for
the `9xxx_*.sql` files.

**What the matrix must contain, per changed migration:**

- **Upgrade from each actor.** Starting schema = the previous version the overlay replaces; the
  migration (`up`/forward) applies cleanly and leaves the schema matching the new code's
  expectations.
- **The id-collision case is checked against a named predicate.** Because `applyMigrations()` is a
  set-membership check with no content check, a deployed store that already carries an id skips it
  offline. A collision row is required for any migration that adopts, reuses, or renumbers an id a
  deployed store could already carry: an upstream-owned id below the 9000 floor, a retired id, or a
  renumbered one. The row seeds a store with the id already recorded, applies the migration, and
  asserts the store's final shape is correct, not merely that the runner reported success. FORK.md's
  35/36 collision shows a store can report itself fully migrated while the tables the code queries
  never exist. The row is waived in writing only when the id is provably brand-new this release,
  with no deployed-history overlap.
- **Rollback to the previous version.** The `down`/reverse path runs and returns the store to a
  state the previous code can serve. FORK.md's `releaseRetiredIdentifiers()` release is rollback
  proof; the matrix treats any migration that cannot roll back as needing a written irreversibility
  reason, consistent with the web-pack rule that a migration ships with a working `down` unless
  deliberately flagged.

**How.** For D1, the integration suite (`packages/control-plane/test/integration/`, which applies
`terraform/d1/migrations/` from a real migration runner) is the harness the matrix rows must live
in. For the session schema, the `applyMigrations()` paths in control-plane tests. Where a row needs
a store seeded with a prior schema and then upgraded, that is a new test in the same suite, not a
one-off script.

**Threshold.** Every overlay-added or overlay-modified migration has one passing upgrade row and one
passing rollback row. A collision row is required wherever the migration adopts, reuses, or
renumbers an id a deployed store could already carry, and is waived in writing only for an id
provably brand-new this release. A written reason is required where rollback is impossible. The
control-plane integration job that hosts them must be green.

**Who.** Automated under full autonomy. The deployed migration set is derived from the previous
release's `MIGRATIONS` array and the D1 migration files, so the rows are chosen against that, not
against a person's memory. A row set that cannot be derived deterministically moves the run to
`manual-intervention`.

## 5. Terraform and Worker binding checks

**Class: blocking (automated) for validate; human judgment for the plan and binding parity.**

**What.** Infrastructure that ships alongside code ships in the same promotion, and the binding
parity is verified, not assumed. Two Terraform paths matter and both are real:

- **Validate.** `terraform fmt -check`, `terraform init`, and `terraform validate` run on the PR
  whenever it touches anything under the triggers in
  [`terraform.yml`](https://github.com/mauricedesaxe/background-agents/blob/main/.github/workflows/terraform.yml)
  (any `packages/`, `terraform/`, `scripts/` path).
- **Plan.** `terraform plan` runs on the PR only when secrets are configured (`check-secrets` →
  `has-secrets == true`). A plan is the only place a binding that was never declared surfaces,
  because TypeScript believes `Env` and tests inject their own env.

**The binding parity guard.** FORK.md's whole class of bug is a Worker binding declared in one place
and not the other: the `Env` interface and the Terraform. The existing guard is
`packages/slack-bot/src/types/env-terraform-parity.test.ts`, which checks one package's bindings
against Terraform. Any overlay that adds, renames, or removes a Worker binding must extend or mirror
that guard for the affected package, because the lesson of FORK.md is that a convergence scoped to
`packages/` with `terraform/` left behind fails silently as a 503 in production.

**Threshold.** Validate is green on the PR. When secrets are available, the plan reports success and
changes only what the overlay intends: nothing that belongs to a different commit range is being
created or destroyed. The every-binding-in-`Env`-is-in-Terraform-and-vice-versa check passes for
each package the overlay touches. When secrets are not configured the plan is skipped and a human
must state that the bindings were reviewed by hand instead; that is a human run that blocks the PR
until it is done.

**Who.** Automated under full autonomy. Validate, the plan, and the binding parity guard run and are
scored unattended. When secrets are unconfigured the plan is skipped and the run moves to
`manual-intervention` instead of a hand review.

## 6. Daytona image rebuilds

**Class: automated, page on failure (full autonomy).**

**What.** A runtime-bearing overlay must prove it builds and runs on the provider this deployment
actually runs, Daytona, before it is promoted. This is not the same as a green CI suite, because a
harness pin alone does not reach a Daytona sandbox.

From [`AGENTS.md`](https://github.com/mauricedesaxe/background-agents/blob/main/AGENTS.md): the
harness installs at image build time, but Daytona's `source_hash` excludes `*.sh`, so editing
`HARNESS_REF` in `install-harness.sh` does not invalidate the snapshot. `SANDBOX_VERSION` has to
move too, and an apply has to rebuild the snapshot, before a harness change reaches a Daytona
sandbox. Modal, Vercel, and OpenComputer hash the installer directly, so their images invalidate on
their own.

**What the gate requires, when the overlay touches `sandbox-runtime/`, `daytona-infra/`, or the
harness pin:**

- `SANDBOX_VERSION` is bumped in the same change as any harness pin, so the apply rebuilds the
  snapshot.
- A fresh sandbox boots from the rebuilt image and completes the setup hooks.
- A resume of an existing session reattaches on the same sandbox (the §6 retained behavior) rather
  than resetting to the remote tip.

**Threshold.** A real provisioned Daytona sandbox boots and resumes from the rebuilt image. The
rebuild is evidenced by a log or a state artifact that names the rebuilt snapshot, not by a green CI
run.

**Who.** Automated. A fresh sandbox is provisioned and resumed against the rebuilt snapshot by the
promotion worker; the evidence is the named snapshot plus the boot/resume result. A boot or resume
failure moves the run to `manual-intervention`.

## 7. Runtime and production probes

**Class: automated, page on failure (full autonomy).**

**What.** The promotion is exercised where it runs before the promotion is declared done. This is
the human-judgment evidence that deterministic tests cannot reach: a live round trip through the
WebSocket chain (client → control-plane DO → sandbox → streamed events back), and, where the overlay
touches a bot package, the webhook → queue → completion path.

The two concrete behaviors an overlay is most likely to regress, from the probe evidence, are the
expensive retained seams: same-sandbox OpenCode continuity and manual compaction (#291 calls these
real retained work at roughly 600 LOC across five seams), and the event pump that decouples SSE from
the WebSocket send (#7). A probe must exercise a real prompt that triggers compaction or a
long-running turn through those seams, because their failure mode is the stream dropping or the
recovered response never reaching the user, which no unit test reproduces.

**How.** The promotion worker runs the probe against the deployed production surface, not staging:
create a session, send a prompt that runs long enough to exercise the retained seams, and confirm
the transcript and streamed events arrive intact. Where a bot package is in the overlay, send a real
webhook and confirm the forward fires (the #12 behavior pinned by
`packages/github-bot/test/webhook-forward.test.ts`). A staging environment cannot stand in, because
the seams the probe exists to catch (binding-parity 503s, the event pump, the webhook forward) are
production-configuration-dependent and behave differently under the deployed configuration.

**Threshold.** The probe runs against the deployed production surface and completes end to end with
the transcript and events intact, and any bot forwarding fires. A skipped probe is a block; the
probe is not satisfiable by saying "the tests passed" or by a staging run.

**Who.** Automated. A probe failure moves the run to `manual-intervention`.

## 8. Production-bearing verification

**Class: automated, page on failure (full autonomy).**

**What.** After merge to `main`, the promotion is confirmed to have actually reached production, not
merely to have been merged. This exists because deploys are unattended and can silently not run.

From [`AGENTS.md`](https://github.com/mauricedesaxe/background-agents/blob/main/AGENTS.md): the
`apply` job runs under `environment: production` with no protection rules, so a merge to `main`
ships unattended and the PR is the only gate. A rebase-merge has been observed producing zero
workflow runs at all, leaving a change on `main` that looks deployed with nothing having run.

**What the gate requires:**

- Confirm a deployment actually ran for the merge, e.g. `gh run list --branch main` after merging,
  and force it with `gh workflow run terraform.yml --ref main` if nothing appeared.
- A healthy post-deploy plan is not judged by "empty", because `always_run = timestamp()` means
  every worker shows as replaced. The signal is that nothing says "will be created": a healthy
  applied state shows replacements, not creations.
- A Daytona snapshot rebuild is confirmed to have happened (section 6) when the overlay carries a
  runtime change, because a pin bump alone ships nothing to a Daytona sandbox.

**Threshold.** A workflow run exists for the merge and reached success; the applied plan shows no
unexpected creates; the deployed surface responds to the section 7 probe.

**Who.** Automated. The workflow run, plan, and probe response are checked by the promotion worker;
a missing run or unexpected create moves the run to `manual-intervention`.

## The promotion checklist

Work this top to bottom. Under the full-autonomy posture in [SYNC_METHOD.md](SYNC_METHOD.md), every
section is automated: any failure or unresolvable ambiguity in any section moves the run to
`manual-intervention` and pages a human. Ordinary non-sync PRs keep the human classes as written
above.

1. [ ] Section 1 deterministic CI: all `ci.yml` jobs green on the head commit.
2. [ ] Section 2 retained behavior: no fork test taken wholesale, no fork test edited without a
       written reason, all pinned-behavior tests green.
3. [ ] Section 3 local-fix regressions: guards green and untrimmed.
4. [ ] Section 4 migrations: one upgrade row, one rollback row; a collision row for any migration
       that adopts, reuses, or renumbers an id a deployed store could already carry, waived in
       writing only for an id provably brand-new this release; a written reason where rollback is
       impossible; host integration suite green, and the rows derived from the previous release's
       migration set.
5. [ ] Section 5 Terraform: validate green, plan reviewed (or the run moves to `manual-intervention`
       when secrets are unconfigured), binding parity guard extended and passing for every touched
       package.
6. [ ] Section 6 Daytona: `SANDBOX_VERSION` bumped with any harness pin; a real sandbox booted and
       resumed from the rebuilt image in a staging environment, evidenced by the named snapshot.
7. [ ] Section 7 probes: a live round trip ran end to end against the deployed production surface
       with transcript and events intact; bot forwarding confirmed where touched.
8. [ ] Section 8 production: a workflow run exists for the merge and succeeded; the applied plan
       shows no unexpected creates; the deployed surface responds to the section 7 probe.

When every box is checked, the promotion is complete and is declared automatically. A box left
unchecked moves the run to `manual-intervention`; it is not a note to revisit.

## How this gate itself is kept honest

This document is the same kind of artifact as FORK.md: it is committed because the analysis it
codifies has a history of being produced and lost. Because it only ever references jobs, files, and
workflows that already exist, it drifts exactly when one of those moves. Re-derive rather than
trust: the CI job list is whatever `ci.yml` actually runs, the migration rules are whatever
`applyMigrations()` actually does, and the Daytona shipping rule is whatever the harness
`source_hash` actually excludes. If a listed artifact moves out of date, update this document in the
same change and say so, the same way FORK.md requires for its claims.
