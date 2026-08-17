# Upstream sync method

Decision for [#267](https://github.com/mauricedesaxe/background-agents/issues/267): how each
complete upstream range moves through detection, throwaway integration, review, acceptance,
promotion, and recorded history. It supersedes the 2026-08-06 decision handoff comment on #267 and
the standing "nothing merges or deploys automatically" rule in [AGENTS.md](../AGENTS.md), for this
workflow only. The retained inventory is [FORK.md](FORK.md); the promotion bar is
[OVERLAY_ACCEPTANCE_GATE.md](OVERLAY_ACCEPTANCE_GATE.md); the one-time cutover shape is
[RECONSTRUCTION_PLAN.md](RECONSTRUCTION_PLAN.md). It feeds
[#272](https://github.com/mauricedesaxe/background-agents/issues/272) (inbound detection),
[#270](https://github.com/mauricedesaxe/background-agents/issues/270) (outbound), and
[#269](https://github.com/mauricedesaxe/background-agents/issues/269) (first cutover).

## Posture: full autonomy, human on failure only

The 2026-08-06 handoff left a human gate in the happy path (GitHub Approve authorizes promotion).
Alex's decision on 2026-08-17 replaces that gate with unattended convergence:

- Detection, rehearsal, candidate construction, deterministic CI, agentic review, the acceptance
  gate, merge, deploy, production probes, and reporting all run without a human in the loop.
- A human is paged (Slack) and the run moves to `manual-intervention` only on failure: CI red, an
  important finding unresolved after the review ceiling, an acceptance-gate failure, a deploy
  failure, or a probe failure.
- This is a deliberate, narrow exception to the "nothing merges or deploys automatically" rule in
  AGENTS.md. Ordinary PRs and every other automation keep their human gate. Only the upstream-sync
  workflow is unattended.
- Because the human-gate sections of OVERLAY_ACCEPTANCE_GATE.md (sections 6, 7, 8: Daytona rebuild,
  production probes, deploy verification) become automated steps that page on failure, that document
  is amended in the same change as this one. The blocking CI and retained-behavior sections (1,
  2, 3) are unchanged: they were always automated.

The unit of intake is one complete, contiguous upstream range. Selective ports are not the normal
model. An isolated commit is taken only as a temporary downstream patch for an urgent security,
data-loss, or production-outage fix, with provenance and a regression test, and it does not advance
the sync cursor (unchanged from the handoff).

## Toolchain: jj for local history, `gh` for the remote

Use jj wherever possible, per Alex's decision. The fork repo becomes jj-colocated during the
reconstruction cutover (RECONSTRUCTION_PLAN.md), so every sync runs in a colocated jj workspace.

- jj drives all local history work: bookmarking the run, building the merge, describing commits, and
  `jj git push`.
- `gh` drives the GitHub remote only: PR create/update/label, status checks, workflow dispatch, and
  the PR merge. The GitHub PR merge is inherently a git/GitHub operation and is the accepted
  git-interop boundary.
- The one local git mutation permitted is `jj git fetch upstream` (jj's own git interop), never raw
  `git commit`/`git merge`/`git push`.

The sync merge commit is produced by jj as a merge whose parents are current `main` and the pinned
upstream head (`jj new main upstream/main`), then exported to git faithfully. Its git shape — first
parent fork `main`, second parent the exact pinned upstream head — is what records "the complete
range was integrated" through ancestry.

## PR state machine and durable representation

A run is one pinned upstream range and one PR. States, in order:

| State                 | Meaning                                                                                   | Who advances it      |
| --------------------- | ----------------------------------------------------------------------------------------- | -------------------- |
| `rehearsing`          | Rehearsal worker builds a throwaway integration on a disposable branch.                   | coordinator          |
| `candidate`           | Candidate worker builds the real sync branch and opens the PR.                            | coordinator          |
| `review`              | Agentic review rounds run against the candidate SHA (rounds tracked in the status table). | coordinator          |
| `remediation`         | Accepted important findings are being fixed.                                              | coordinator          |
| `acceptance`          | The full OVERLAY_ACCEPTANCE_GATE runs against the stabilized candidate SHA.               | coordinator          |
| `promoting`           | Merge, deploy, probes run unattended.                                                     | coordinator          |
| `deployed`            | Success. PR merged, deploy and probes confirmed.                                          | coordinator          |
| `manual-intervention` | Failure. Human paged; automation halts on this PR.                                        | coordinator or human |
| `no-op`               | No new upstream range; the run creates no PR.                                             | coordinator          |

Durable representation:

- **Label** `upstream-sync` marks the PR, plus one state label (`sync:rehearsing`, `sync:review`,
  `sync:manual-intervention`, ...). The label set is the resumable cursor across coordinator
  sessions.
- **Status table** in the PR body, updated idempotently: run id, pinned start/end SHA, current
  state, review round, reviewer slots, and the disposition of each finding. One marker line
  (`<!-- sync-status -->`) anchors the replacement so the table is rewritten, not appended.
- **Idempotency marker** is the run id `startSHA..endSHA`. Every transition first checks the PR is
  in the expected state and the run id matches; a transition from an unexpected state is a no-op.
  This makes resume-after-crash safe.

## Finding classification contract

Each reviewer finding is classified into exactly one of:

- **`important`** — a named, concrete failure mode with file/line evidence: incomplete range
  integration, incorrect conflict resolution, resurrected fork code, lost retained behavior, unsafe
  patch removal, wholesale fork-test replacement, migration collision, package-to-Terraform drift,
  invalid acceptance evidence, or deployment-failure risk.
- **`advisory`** — style, naming, duplication, speculative risk, unsupported suspicion, or a
  maintenance-budget note.

The boundary that moves work to a human: a finding the classifier can neither verify nor refute with
evidence is escalated to `manual-intervention`, never auto-dismissed. An `important` finding forces
`remediation`; an `advisory` finding does not. A finding rejected during review stays visible with a
written, evidence-based disposition. Agent reviews are not votes.

## Artifact schemas

Structured artifacts cross session boundaries; only these fields, nothing free-form, no transcripts.

- **rehearsal-report**: pinned range, conflict list (per file), changed seams keyed to FORK.md rows,
  migration risks, redundant patches, required acceptance coverage.
- **candidate-handoff**: pinned range, retained-overlay manifest, rehearsal-report reference, and
  the candidate SHA.
- **reviewer-report**: round, reviewer slot, reviewed SHA, and findings (id, classification,
  evidence, severity).
- **remediation-brief**: the accepted finding set and the candidate SHA it applies to.

## Async outcomes

- **Stage deadlines.** Every stage has a timeout; a stage that exceeds it moves to
  `manual-intervention` with the timeout recorded.
- **Stale SHA.** Any report or check result referencing a SHA that is not the candidate's current
  head SHA is discarded.
- **Duplicate review attempts.** Deduplicated by (round, slot, SHA); a re-dispatch of the same round
  against the same SHA is a no-op.
- **Child-session completion.** The coordinator waits on dispatched child sessions with a deadline;
  a missing completion moves to `manual-intervention`.

## GitHub events

Beyond the handoff's `pull_request_review.submitted` and `pull_request.labeled`, the coordinator
consumes:

- `check_suite.completed` / `check_run.completed` — the deterministic CI signal.
- `pull_request.opened` / `reopened` / `synchronize` — candidate lifecycle.
- `workflow_run.completed` — deploy finished.
- `push` to `main` — post-merge deploy verification.

No `issue_comment` events: there is no magic-comment authorization.

## Permissions

Replace the current broad GitHub credentials with a capability-scoped token carrying only what the
workflow needs: `contents:write` (branch + merge), `pull-requests:write` (create/update/label),
`workflows:write` (dispatch the deploy and force a missing run), and read access to check runs,
deploy status, and logs for the probes. No scope wider than that, and no token that can write to the
upstream repository — outbound remains report-only.

## Keeping rebase-merge policy for ordinary PRs

`main` carries no branch-protection rules today (verified: the protection API returns 404), so
rebase-merge is currently convention, not enforcement. Under full autonomy that convention needs a
machine guardrail:

- Add a status check that fails any PR whose merge would introduce a commit with more than one
  parent unless the PR carries the `upstream-sync` label. Ordinary PRs therefore keep rebase-merge
  as enforced policy, and only the labeled sync merge is exempt.
- No branch-protection rule needs to be relaxed, because none exists. The check is the enforcement
  that was previously only a habit.

## Notifications

One Slack TLDR per run, no per-round noise:

- **Success** — one message: range summary, retained seams touched, and probe result.
- **Failure** — one message: the failing stage and what broke, with a link to the PR in
  `manual-intervention`.
- **No-op** — silent; a no-range run produces no message.

## Fan-out

- **#272 (inbound)** — the `no-op` head check and the `rehearsing` trigger _are_ the inbound
  assessment. Replace the existing daily per-commit classification job with this coordinator.
- **#268 (patch record)** — FORK.md stays the canonical record. No new committed sync ledger, no
  per-range tag, no immutable per-commit classification report (unchanged from the handoff).
- **#271 (budget)** — a seam exceeding its maintenance budget surfaces as an `advisory` finding of
  type `budget-exceeded`, which triggers the configured/redesign/drop decision rather than silent
  carry.
- **#273 (proof)** — the rehearsal that proved the replace-commit reconstruction is the same
  rehearsal the `rehearsing` stage runs against each new range.
