# Inbound upstream-range detection

Decision for [#272](https://github.com/mauricedesaxe/background-agents/issues/272): how inbound
automation detects new upstream ranges, triggers the sync coordinator, and replaces the existing
daily per-commit classification job. It sits under the [SYNC_METHOD.md](SYNC_METHOD.md)
coordinator's `no-op` → `rehearsing` transition.

## Cursor

The durable cursor is the `to_sha` of the last fully integrated and deployed upstream range. It is
stored as a git ref (`refs/sync/last-integrated-upstream`) on the fork — reachable via git, never
expiring in reflog, never force-moved except by a successful deployed sync. A missing ref means no
sync has ever completed; the bootstrap case uses the fork root at the reconstruction cutover point.

## Head-check cadence

Every six hours, a scheduled automation fetches upstream and compares `upstream/main` against the
cursor. The head check is cheap: `git fetch upstream` then
`git rev-list --count <cursor>..upstream/main`. A zero-count terminates silently — no PR, no Slack
message, no run id.

## Trigger

A non-zero count triggers the full sync coordinator:

1. Pin the range: start SHA = cursor ref, end SHA = `upstream/main` at trigger time.
2. Launch the `rehearsing` stage of the SYNC_METHOD.md state machine.
3. The coordinator drives everything from there.

Upstream movement during an active run is ignored. The pinned end SHA is fixed; a run that finishes
with a new upstream head ahead of it proceeds as normal, and the next head check picks up the new
range.

## Range verdicts

The rehearsal-report includes a verdict, derived from the changed surface:

- **`clean`** — no FORK.md seam file was touched; the merge is expected to apply with zero or
  trivial conflicts. Proceed to candidate.
- **`retained-seams-touched`** — one or more FORK.md-retained files changed upstream. The
  rehearsal-report surfaces every changed seam keyed to its FORK.md row. Proceed to candidate; the
  sync-method review round is the gate.
- **`needs-decision`** — the rehearsal found a conflict or ambiguity the classifier cannot resolve
  deterministically. The run moves to `manual-intervention` and pages a human (Slack).

There is no intermediate "hold for scheduling" verdict. The coordinator always proceeds unless
`needs-decision` stops it.

## Overlay-version-aware reassessment

Every run is fresh. The rehearsal runs against the current fork tree, which includes the retained
overlay as it exists at the time the run starts. Classifications from prior runs are not reused,
because the overlay state changes between runs and a prior classification's relevance depended on
the state it was produced against. The durable cursor is the only persisted signal between runs;
everything else is recomputed.

## What the existing ledger loses

The current daily automation and D1 scan ledger are replaced:

- The cursor ref replaces the finalized `to_sha` in the D1 `upstream_exchange` tables.
- Per-commit immutable classifications are dropped. Under whole-range sync, a single commit's
  relevance to the fork is transient and is not useful as a durable artifact. The range verdict and
  the git ancestry of the sync merge are the durable record.
- The two web automation templates (`upstream-exchange-outbound`, `upstream-exchange-inbound`) are
  retired. The coordinator replaces them.
- The D1 `upstream_exchange` tables and migration `9007_upstream_exchange_ledger.sql` are dropped
  during the reconstruction cutover. The coordinator is a clean replacement, not a layered addition.
- The existing Slack notification machinery stays; the coordinator reuses the same `slack-notify`
  path.
