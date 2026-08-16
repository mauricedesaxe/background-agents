# Reconstruction and cutover history

Decision for [#265](https://github.com/mauricedesaxe/background-agents/issues/265): the exact Git
and deployment history that reconstructs this fork from current upstream and cuts production over
without rewriting deployed history. It feeds
[#269](https://github.com/mauricedesaxe/background-agents/issues/269) (rollout and rollback) and
sits under the [wayfinder map #263](https://github.com/mauricedesaxe/background-agents/issues/263).
The behavior this preserves is catalogued in [FORK.md](FORK.md); the retained seam sizes come from
the
[#291 measurement](https://github.com/mauricedesaxe/background-agents/issues/291#issuecomment-5224806472).
The promotion evidence is [OVERLAY_ACCEPTANCE_GATE.md](OVERLAY_ACCEPTANCE_GATE.md), which is the
concrete gate #266 produced; this plan cites that document, not the issue.

## Verdict

Reconstruct on a fresh branch built at fork `main`'s tip, not by merging the two histories. The
first commit replaces the entire working tree with the chosen upstream HEAD, then the retained
overlay is re-created on top as a small stack of atomic commits. The fork lineage is abandoned as
history, frozen rather than deleted: the fork commits stay first-parent ancestors of the new `main`
through the replace commit, preserved read-only under a tag and a legacy branch. Cut `main` over by
a pointer move carried in through a merge-commit PR that triggers CI. The rollback anchor for
production is a tag at the pre-cutover `main` tip plus non-destructive, additive D1 migrations.

## Why a merge is not an option

[The #273 core-seam probe](https://github.com/mauricedesaxe/background-agents/issues/273#issuecomment-5221520405)
built a throwaway merge of fork `main` into upstream `b63d0175` on `rehearsal/upstream-b63d0175`. It
produces **355 conflicted files**: both histories touched 534 of the same files, and 145 are
fork-only. Nobody resolves that by hand. That is the binding constraint: any reconstruction shaped
as a `git merge` of the two divergent lineages fails before it starts, so the plan below never runs
one. The reconstruction branch is built by writing files onto a fresh upstream base, not by merging
history.

Recompute rather than trust the SHAs below, in the same way FORK.md insists. The 2026-08-07 baseline
was fork `3361bd8d`, upstream `b63d0175`, merge base `0a7534211a34b93d339eda116dbe319eebe6820f`.
Fork `main` and `upstream/main` both move, and the fork keeps producing retained behavior, so the
cut point is frozen at execution start, not at planning time. At execution, re-derive the head with
`git merge-base HEAD upstream/main`, and read the fork tip as of the moment the reconstruction
starts. The upstream head to cut over to is **current `upstream/main`**, not the probe's pinned
`b63d0175`, because cutting to the pinned head saves a small gap now but forces a second
reconstruction when upstream has moved again.

## Reconstruction branch shape

The reconstruction is a write-files operation, so it needs a fixed fork snapshot and a fixed
upstream head. Freeze both when execution begins.

```sh
git fetch upstream
git checkout -b reconstruct/upstream-<short> main
```

Create the branch at fork `main`'s tip, never off the upstream lineage. Then, in order:

1. **Replace the tree with upstream's HEAD.** One commit whose tree is byte-identical to the chosen
   upstream head. This single commit absorbs the "upstream-native adoptions" step: upstream's split
   bridge modules and the `task` to `child` fan-out rename are in this commit already, so there is
   no separate adoption commit. Because this commit is unreviewable by design, it carries a
   mechanical proof: `git diff --quiet <replace> <upstream-head>` must be empty. That converts
   "trusted wholesale" from a claim into a check, and it guarantees the overlay diff is exactly the
   retained delta with nothing accidental leaked in.
2. **Additive-first overlay commits.** Commit the fork-only files with zero upstream counterpart
   before anything that touches upstream-owned files: `packages/control-plane/src/board/`,
   `routes/board.ts`, `packages/web/src/components/board-*.tsx`, the whiteboard skill,
   `.claude/agents/`, and the D1 migrations in the reserved 9000+ range. These can never conflict
   because upstream has none of them ([FORK.md §9](FORK.md), [FORK.md "fork-only files"](FORK.md)).
3. **Thin integration patches per seam.** Re-apply each retained seam against the new layout.

Each overlay commit is one retained behavior (FORK.md row or #291 seam), grouped by the file it
touches and ordered least-to-most invasive, so commits that edit the same file sit adjacent and a
later, narrower commit never re-opens work an earlier one finished. Each commit updates its own
FORK.md entry's `Last-verified upstream SHA` in the same commit, so bisecting a regression lands at
a commit whose FORK.md state is consistent with its code. The stack is reviewable as a whole and
green at the tip; individual commits are not required to pass independently, because forcing that
would grow every commit with its call sites and make each one less reviewable.

This shape avoids the 355 conflicts because the branch never runs a two-way merge of the two
divergent histories. The replace commit takes upstream's tree whole; the overlay then re-imposes
only the retained deltas on top, so there is no upstream side left to reconcile.

The reconstruction moves only tracked content. `.opencode/skills/` is untracked in the working tree;
the whiteboard skill's source of truth is
`packages/sandbox-runtime/src/sandbox_runtime/skills/whiteboard/` (FORK.md §9), and the
`.opencode/skills/` copies are harness-install artifacts reproduced in the sandbox image, not part
of the overlay. Nothing under `.opencode/` belongs in the reconstruction branch.

## How the retained overlay is organized

The
[#291 measurement](https://github.com/mauricedesaxe/background-agents/issues/291#issuecomment-5224806472)
is the authoritative size guide. Upstream decomposed `bridge.py` from 1965 to 1184 lines into
`prompt_stream.py`, `event_forwarder.py`, `child_activity.py`, and `opencode_identifier.py`; the
fork grew the same file to 2654. Of the fork's 1470 extra lines over upstream, roughly 600 are
genuinely retained, roughly 600 are now upstream-native, and roughly 270 are refactor noise.

**Adopt upstream's split modules, do not re-impose the fork's bridge.** This drops the ~600
upstream-native lines as a pure adoption. The overlay then re-attaches six seams into the new
modules:

| Seam (retained)                 | Approx LOC | Where it attaches                                                                          | FORK.md |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------ | ------- |
| Reattach fail-closed            | ~140       | `opencodeSessionId` verify-before-ready, `context_unavailable` gating                      | §6      |
| Manual compaction (`summarize`) | ~110       | no `summarize` command upstream; add the protocol command                                  | §6      |
| Event-pump + OOM                | ~130       | fork `EventPump` is a pump task with eviction; upstream `BufferedEventForwarder` is inline | §7      |
| jj-aware PR helper              | ~150       | `_run_jj`, `_jj_working_copy_has_changes`, no-commits-beyond-trunk                         | §8      |
| Provider-retry events           | ~40        | absent upstream                                                                            | §6      |
| Repeated-overflow terminal      | small      | fork fails a repeated `ContextOverflowError`; upstream swallows every one                  | §6      |

The sixth seam exists because upstream's overflow handling is **not a drop-in**. The #291 probe read
upstream's `_on_session_error` line by line and found two differences, one each way. Upstream adds
`_unrecovered_overflow_events`: a session that idles without compacting surfaces the overflow and
fails, where the fork relies on the §25 progress deadline to catch a stuck prompt. The fork fails on
a repeated overflow (a second `ContextOverflowError` is terminal); upstream swallows every overflow.
Adopting upstream wholesale would therefore drop the repeated-overflow-terminal invariant and
re-introduce the regression FORK.md §6 warns about, a compaction that keeps failing now retrying
forever instead of failing closed. Keep repeated-overflow-terminal as a small additional seam on top
of upstream's `_on_session_error`.

**Additive capability.** Sandbox archive is purely additive with zero upstream counterpart:
`supportsArchive`, `ArchiveConfig`, `ArchiveResult`, `archiveSandbox`, the descendant cascade
([FORK.md §4](FORK.md)), plus D1 migration `9006`.

Upstream now owns several behaviors FORK.md §6 used to claim, which the plan therefore **drops from
the overlay** rather than re-implements: session title normalization, error extraction, salvage
partial output, child/subtask handling, the event buffer/ack delivery, and session-id file
persistence. The ~270 lines of refactor noise the #291 probe classifies are dropped too, but not
blindly: the reconstruction verifies them with a diff of the dropped lines and a confirmation that
no test references any of them before they are deleted. The #291 method note flags that the fork
inlines whole upstream modules, so a straight diff overstates retained LOC, which is why the plan
sizes the seams from the per-feature verdict table instead of a raw diff.

### Control-plane is not measured

#291 measured only the bridge. The other ~20 FORK.md entries touch control-plane, the heaviest
package by far (archive cascade, child-results delivery, unread state, sidebar pagination, board,
voice input, automations), and none of them has a size estimate. The shape this plan decides does
not depend on that size, so #265 does not block on it. It is a cost input that
[#273](https://github.com/mauricedesaxe/background-agents/issues/273) (proof) and
[#271](https://github.com/mauricedesaxe/background-agents/issues/271) (budget) must surface,
recorded here as a known unknown.

## Reconciling the existing fork lineage

The lineage splits three ways, and "abandoned" means frozen, not deleted.

- **Abandoned as history.** The fork commits are not merged and not carried forward. They built a
  diverged tree against upstream's old shape; a whole-history merge yields 355 conflicts, so the
  lineage is retired as history. It is preserved read-only under a protective ref (a tag at the
  freeze-point `main` tip, and a long-lived `fork/legacy-<short>` branch). Preserving, not deleting,
  is what honors "without rewriting deployed history".
- **Re-applied as overlay commits.** The retained behaviors (FORK.md rows plus the #291 seams plus
  the uncatalogued work the probe flags, e.g. `707f756` child-results delivery and its follow-ups,
  which the probe notes no FORK.md row covers) are re-created as fresh commits on the reconstruction
  branch against current upstream. This is the [test files merged by hand](FORK.md) rule applied at
  the whole-file level: any behavior that does not re-apply cleanly is evidence the port dropped it,
  not a stale test to delete.
- **Adopted as upstream-native.** The ~600 upstream-native lines, upstream's overflow handling minus
  the repeated-overflow-terminal seam, and the `task` to `child` fan-out rename are taken from
  upstream wholesale. The rename is an adoption, not a conflict.

The fork commits stay in `main`'s first-parent ancestry through the replace commit. That is
unavoidable without rewriting history, and it is fine: the protective tag and legacy branch are
about reachability after `main` moves on, not about erasing the past. The fork keeps producing
retained behavior, so the reconstruction's inventory source is FORK.md rows plus the #291 seams plus
`git log <last-FORK.md-baseline>..HEAD` to surface every commit that landed after FORK.md last
changed. The uncatalogued work is catalogued as part of the reconstruction: each such commit is
written up as a FORK.md entry in the same overlay commit that re-applies it.
[#268](https://github.com/mauricedesaxe/background-agents/issues/268) then reconciles and formalizes
what the reconstruction produced, rather than gating it.

## Rollback anchors

Production rollback must not depend on defeating a destructive migration, so it anchors in four
places.

- **Pre-cutover `main` tag.** Tag the exact deployed code at the freeze point before the pointer
  move: `git tag fork/pre-reconstruction-<short> <freeze-point>`. This is the code rollback target.
  It is never force-moved, so reverting production to what is running today is a routine deploy of a
  tagged commit, exactly as FORK.md's non-destructive posture wants.
- **One tag per overlay commit.** Because the overlay is a stack of atomic commits, the cutover can
  walk back one behavior at a time by reverting a single commit and redeploying, instead of
  reversing the whole reconstruction.
- **Legacy branch.** `fork/legacy-<short>` sits alongside the tag so the lineage survives reflog
  expiry differently. The tag and branch are convention-protected, not GitHub-protected: the repo
  runs production with no protection rules anywhere, and adding a one-off rule for a legacy ref is
  machinery with no precedent here. Note "do not force-push" in FORK.md and move on.
- **Additive D1 migrations.** Fork-local migrations keep the reserved 9000+ range and the
  [release-retired-identifiers mechanism FORK.md describes](FORK.md), and the cutover follows the
  expand, backfill, contract discipline this repo applies as non-destructive migrations. The replace
  commit takes upstream's migration array whole, but the overlay re-imposes the reserved-range
  discipline: our 9001 guarded re-site stays, our 9005 through 9008 stay, and the
  `releaseRetiredIdentifiers` helper stays and self-disables correctly, because upstream's reclaimed
  35 and 36 are in `MIGRATIONS` and the filter excludes them. Rollback never requires undoing a
  destructive migration because no migration drops live data; it reverts to the tagged pre-cutover
  code and leaves the additive columns in place.

The cutover moves `main`'s pointer to the reconstruction tip. This replaces the branch lineage
without modifying a single published commit: the old commits stay intact and reachable through the
tag and legacy branch, so deployed history is never rewritten.

## Cutover deploy steps

These reference the CI/CD model in [AGENTS.md](../AGENTS.md) and FORK.md's deployment gotchas.

1. **Push and open the cutover PR** targeting `main`, with the reconstruction branch as head.
   Validate the replay of the retained behaviors against
   [OVERLAY_ACCEPTANCE_GATE.md](OVERLAY_ACCEPTANCE_GATE.md) before merging. This PR is the only
   gate; the `apply` job runs under production with no protection rules ([AGENTS.md](../AGENTS.md)).
2. **Merge with a merge commit, not a rebase-merge.** A rebase-merge has been observed producing
   zero workflow runs at all, leaving the change on `main` with nothing executed
   ([issue #75](https://github.com/mauricedesaxe/background-agents/issues/75)). A reconstruction
   that replaces `main`'s lineage makes a rebase the worst choice, so the cutover must be a plain
   merge. Because the branch is built at `main`'s tip, it is fast-forwardable; the merge commit is
   forced so CI has a merge to react to.
3. **Confirm a workflow run started.** `gh run list --branch main`. If nothing appeared, force it
   with `gh workflow run terraform.yml --ref main`.
4. **Terraform apply** deploys the control plane and the D1 migrations in array order. Fork-local
   migrations use 9000+ IDs and sit after any upstream migration they depend on, because execution
   order is the literal array order, not the ID ([FORK.md](FORK.md), [AGENTS.md](../AGENTS.md)). Web
   deploys for Vercel or Cloudflare depend on `web_platform`; Terraform covers the Cloudflare path.
5. **A healthy post-deploy plan is not empty.** `always_run = timestamp()` means every worker shows
   as replaced; the signal is that nothing says `will be created`, which is what a fresh migration
   table would look like.
6. **Runtime-bearing changes need a Daytona rebuild.** The bridge reimplementation (the core-seam
   reattachment, compaction, event-pump, and OOM work) and the sandbox-archive capability touch the
   sandbox image. Daytona's `source_hash` excludes `*.sh`, so editing `HARNESS_REF` in
   `install-harness.sh` alone does not invalidate the snapshot
   ([issue #94](https://github.com/mauricedesaxe/background-agents/issues/94)). Bump
   `SANDBOX_VERSION` and run an apply that rebuilds the snapshot so the harness and runtime changes
   actually reach a Daytona sandbox, then run the production probes the gate calls for.

## Checkpoint

This plan decides the history shape and the cutover mechanics. It does not execute the cutover, does
not run the acceptance gate, and does not write upstream. Decisions downstream that sit on top of
this one are researched, but Alex approves and closes #265; the PR for this plan is the artifact.

## Resolved decisions

The points this plan originally left open are now decided.

- **Upstream head:** current `upstream/main` at execution time, recomputed via `git merge-base`.
- **Uncatalogued work:** in scope for this reconstruction, catalogued into FORK.md as it is
  re-applied, with #268 formalizing afterward.
- **Legacy ref:** a tag and a `fork/legacy-<short>` branch, both convention-protected.
