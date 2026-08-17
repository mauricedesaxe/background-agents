# Outbound upstream issue-candidate assessment

Decision for [#270](https://github.com/mauricedesaxe/background-agents/issues/270): how read-only
outbound automation identifies fork-local fixes that are generally useful upstream and prepares
issue-ready evidence, without writing to the upstream repository. It feeds FORK.md patch-status
transitions but does not create or propose upstream artifacts.

## Safety: report-only by design

The automation never writes to `ColeMurray/background-agents`. It produces evidence and notifies a
human. The human decides whether to open an upstream issue, and never through an automated path.
This is the same `#175` safety boundary the current outbound template observes, now formalized as
the permanent posture: outbound is a suggestion engine, not a contributor.

## Eligibility

A local fix is an outbound candidate when all of these hold:

- It is a genuinely general correctness fix, not a fork-specific feature or deployment value.
- The bug still exists in current upstream (verified against the pinned upstream head from the last
  sync cursor).
- No existing upstream issue covers it (searched via GitHub Issues on
  `ColeMurray/background-agents`).
- It carries a regression test in the fork that can serve as reproduction evidence.

Fork-specific behaviors (Daytona sizing, jj toolchain, whiteboard, harness, OpenRouter, archive
policy, idle window, session tree, unread state) are never outbound candidates. Local fixes not
present upstream are only candidates if they apply to upstream's code exactly as written — a fix
interleaved with a fork divergence is not separable and is not a candidate.

## Evidence bundle

For each candidate, produce a structured evidence block containing:

- The one-line fix summary.
- The fork commit SHA and the upstream commit range where the bug was verified still present.
- Reproduction steps (derived from the regression test).
- The minimal affected code (file + line range in upstream, if determinable).
- The fork regression test file and case name.
- A suggested issue title.

This is what the human reads in the Slack notification and pastes into an upstream issue body.

## Patch-status transitions

The outbound assessment writes to FORK.md's patch-status fields for existing entries. A local fix's
lifecycle is:

| Status                          | Meaning                                                                    |
| ------------------------------- | -------------------------------------------------------------------------- |
| `local-permanent`               | Not a general fix; fork-specific and staying.                              |
| `upstream-issue-open`           | A human opened an upstream issue (issue link recorded).                    |
| `upstream-fix-pending-adoption` | Upstream has merged a fix; next sync will drop our patch.                  |
| `upstream-equivalent`           | Current upstream code passes the fork regression test; patch is removable. |
| `dropped`                       | The patch was removed; the entry is archived in FORK.md history.           |

A fix is automatically reclassified to `upstream-equivalent` when the sync rehearsal detects that
current upstream passes the fork's regression test for that fix. All other transitions are human
actions recorded in FORK.md.

## Cadence

The outbound assessment runs against the same upstream head as the most recent completed sync, not
on a separate schedule. It is part of the sync coordinator's acceptance stage: after the candidate
passes the acceptance gate but before promotion. This keeps the evidence grounded against a
known-good sync point rather than a moving upstream head.

## Human action point

The Slack notification includes each candidate's evidence block. The human opens the upstream issue
(or does not) and updates the FORK.md status. No follow-up automation tracks the upstream issue's
resolution; that is the human's responsibility.
