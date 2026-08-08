# Reconstruction and cutover history

Decision for [#265](https://github.com/mauricedesaxe/background-agents/issues/265): the exact Git
and deployment history that reconstructs this fork from current upstream and cuts production over
without rewriting deployed history. It feeds
[#269](https://github.com/mauricedesaxe/background-agents/issues/269) (rollout and rollback) and
sits under the [wayfinder map #263](https://github.com/mauricedesaxe/background-agents/issues/263).
The behavior this preserves is catalogued in [FORK.md](FORK.md); the retained seam sizes come from
the
[#291 measurement](https://github.com/mauricedesaxe/background-agents/issues/291#issuecomment-5224806472).

## Verdict

Reconstruct on a fresh branch off current upstream head, not by merging the two histories. Re-create
the retained overlay as a small stack of atomic commits on top of that upstream, written into the
current upstream layout. Abandon the 248-commit fork lineage as history and preserve it read-only
under a protective ref; do not merge it and do not force-rewrite it. Cut `main` over by a pointer
move that carries the reconstruction tip in as the new first-parent lineage after a merge-commit PR
that actually triggers CI. The rollback anchor for production is a tag at the pre-cutover `main` tip
plus non-destructive, additive D1 migrations.

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
Fork `main` has since advanced to `ee361f0`, and `upstream/main` now sits at `8b10df25`. Only the
merge base has held. At execution time, re-derive the head with `git merge-base HEAD upstream/main`.

## Reconstruction branch shape

Create the branch off the current upstream head, never off the fork lineage:

```sh
git fetch upstream
git checkout -b reconstruct/upstream-<short> upstream/<head>
```

Then build the overlay as a stack of small atomic commits on top. Each commit is one retained
behavior (FORK.md row or #291 seam), self-contained and reviewable on its own, so each is also a
rollback anchor if the cutover walks back one behavior at a time. The order matters:

1. **Additive-first.** Commit the fork-only files with zero upstream counterpart before anything
   that touches upstream-owned files: `packages/control-plane/src/board/`, `routes/board.ts`,
   `packages/web/src/components/board-*.tsx`, the whiteboard skill, and the D1 migrations in the
   reserved 9000+ range. These can never conflict because upstream has none of them
   ([FORK.md §9](FORK.md), [FORK.md "fork-only files"](FORK.md)).
2. **Upstream-native adoptions.** Take upstream's split modules and the `task` to `child` fan-out
   rename wholesale; these replace fork versions rather than patch over them.
3. **Thin integration patches per seam.** Re-apply each retained seam against the new layout.

This shape avoids the 355 conflicts because the branch never runs a two-way merge of the two
divergent histories. The fork's edits are re-applied onto a tree that already contains current
upstream, so there is no upstream side left to reconcile: any file upstream changed is taken as
upstream's, and only the small retained deltas are re-imposed on top.

## How the retained overlay is organized

The
[#291 measurement](https://github.com/mauricedesaxe/background-agents/issues/291#issuecomment-5224806472)
is the authoritative size guide. Upstream decomposed `bridge.py` from 1965 to 1184 lines into
`prompt_stream.py`, `event_forwarder.py`, `child_activity.py`, and `opencode_identifier.py`; the
fork grew the same file to 2654. Of the fork's 1470 extra lines over upstream, roughly 600 are
genuinely retained, roughly 600 are now upstream-native, and roughly 270 are refactor noise.

**Adopt upstream's split modules, do not re-impose the fork's bridge.** This drops the ~600
upstream-native lines as a pure adoption. The overlay then re-attaches five seams into the new
modules:

| Seam (retained)                 | Approx LOC | Where it attaches                                                                          | FORK.md |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------ | ------- |
| Reattach fail-closed            | ~140       | `opencodeSessionId` verify-before-ready, `context_unavailable` gating                      | §6      |
| Manual compaction (`summarize`) | ~110       | no `summarize` command upstream; add the protocol command                                  | §6      |
| Event-pump + OOM                | ~130       | fork `EventPump` is a pump task with eviction; upstream `BufferedEventForwarder` is inline | §7      |
| jj-aware PR helper              | ~150       | `_run_jj`, `_jj_working_copy_has_changes`, no-commits-beyond-trunk                         | §8      |
| Provider-retry events           | ~40        | absent upstream                                                                            | §6      |

**Additive capability.** Sandbox archive is purely additive with zero upstream counterpart:
`supportsArchive`, `ArchiveConfig`, `ArchiveResult`, `archiveSandbox`, the descendant cascade
([FORK.md §4](FORK.md)), plus D1 migration `9006`.

Upstream now owns several behaviors FORK.md §6 used to claim, which the plan therefore **drops from
the overlay** rather than re-implements: `ContextOverflowError` deferral, session title
normalization, error extraction, salvage partial output, child/subtask handling, the event
buffer/ack delivery, and session-id file persistence. The #291 method note flags that the fork
inlines whole upstream modules, so a straight diff overstates retained LOC, which is why the plan
sizes the seams from the per-feature verdict table instead of a raw diff.

## Reconciling the existing 248-commit fork lineage

The lineage splits three ways.

- **Abandoned as history.** The 248 fork commits are not merged and not carried forward. They built
  a diverged tree against upstream's old shape; a whole-history merge yields 355 conflicts, so the
  lineage is retired as history. It is preserved read-only under a protective ref (a tag at the
  current `main` tip, and a long-lived `fork/legacy-<short>` branch) so it is never force-rewritten
  and never lost. Preserving, not deleting, is what honors "without rewriting deployed history".
- **Re-applied as overlay commits.** The retained behaviors (FORK.md rows plus the #291 seams plus
  the uncatalogued work the probe flags, e.g. `707f756` child-results delivery and its follow-ups,
  which the probe notes no FORK.md row covers) are re-created as fresh commits on the reconstruction
  branch against current upstream. This is the [test files merged by hand](FORK.md) rule applied at
  the whole-file level: any behavior that does not re-apply cleanly is evidence the port dropped it,
  not a stale test to delete.
- **Adopted as upstream-native.** The ~600 upstream-native lines, upstream's `ContextOverflowError`
  handling, and the `task` to `child` fan-out rename are taken from upstream wholesale. The rename
  is an adoption, not a conflict.

## Rollback anchors

Production rollback must not depend on defeating a destructive migration, so it anchors in three
places.

- **Pre-cutover `main` tag.** Tag the exact deployed code before the pointer move:
  `git tag fork/pre-reconstruction-<short> ee361f0`. This is the code rollback target. It is never
  force-moved, so reverting production to what is running today is a routine deploy of a tagged
  commit, exactly as FORK.md's non-destructive posture wants.
- **One tag per overlay commit.** Because the overlay is a stack of atomic commits, the cutover can
  walk back one behavior at a time by reverting a single commit and redeploying, instead of
  reversing the whole reconstruction.
- **Additive D1 migrations.** Fork-local migrations keep the reserved 9000+ range and the
  [release-retired-identifiers mechanism FORK.md describes](FORK.md), and the cutover follows the
  expand, backfill, contract discipline this repo applies as non-destructive migrations. Rollback
  never requires undoing a destructive migration because no migration drops live data; it reverts to
  the tagged pre-cutover code and leaves the additive columns in place.

The cutover moves `main`'s pointer to the reconstruction tip. This replaces the branch lineage
without modifying a single published commit: the old commits stay intact and reachable through the
tag and legacy branch, so deployed history is never rewritten.

## Cutover deploy steps

These reference the CI/CD model in [AGENTS.md](../AGENTS.md) and FORK.md's deployment gotchas.

1. **Push and open the cutover PR** targeting `main`, with the reconstruction branch as head.
   Validate the replay of the retained behaviors against the acceptance gate from
   [#266](https://github.com/mauricedesaxe/background-agents/issues/266) before merging. This PR is
   the only gate; the `apply` job runs under production with no protection rules
   ([AGENTS.md](../AGENTS.md)).
2. **Merge with a merge commit, not a rebase-merge.** A rebase-merge has been observed producing
   zero workflow runs at all, leaving the change on `main` with nothing executed
   ([issue #75](https://github.com/mauricedesaxe/background-agents/issues/75)). A reconstruction
   that replaces `main`'s lineage makes a rebase the worst choice, so the cutover must be a plain
   merge.
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
   actually reach a Daytona sandbox, then run the production probes the reconstruction calls for.

## Checkpoint

This plan decides the history shape and the cutover mechanics. It does not execute the cutover, does
not run the acceptance gate, and does not write upstream. Decisions downstream that sit on top of
this one are researched, but Alex approves and closes #265; the PR for this plan is the artifact.

## Open questions for Alex

- Which upstream head to cut over to at execution time: the probe's pinned `b63d0175` or the current
  `upstream/main` at `8b10df25`. The plan works for either; the choice changes the re-derive step.
- Whether the uncatalogued retained work the probe flags (`707f756` and follow-ups) is in scope for
  this reconstruction or tracked separately in
  [#268](https://github.com/mauricedesaxe/background-agents/issues/268) first.
- Whether the `main` pointer move should also carry a backup branch (`fork/legacy-<short>`) in
  addition to the tag, or just the tag.
