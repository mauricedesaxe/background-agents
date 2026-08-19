# Sync runbook

The blocking gate for every 2-week sync. Run these checks in order. Any failure means **the sync is
not good** — block the PR or roll back. Do not proceed.

## Before the sync (baseline)

1. Fetch upstream. Overwrite the whole tree with upstream **except `overlay/`**.
2. Rebuild each keep-card in `cards/` onto the fresh upstream, in dependency order (see below). Each
   lands with its acceptance test.

### The overwrite, concretely

Do not diff-and-merge fork `main` against upstream — that is the #327 partial-cutover trap. **Base
the sync branch on upstream, then lay `overlay/` back on top.** The tree then equals upstream
exactly, plus the one directory, with no stale fork files surviving by accident:

```
git fetch upstream
git switch -c sync/<date> upstream/main    # tree == upstream, verbatim
git checkout main -- overlay/              # restore the only durable directory
git commit -m "chore: blind-sync to upstream <sha>, restore overlay"
```

`overlay/` is now the sole diff against upstream. Rebuild the keep-cards on top of this commit.
Deletions handle themselves: anything on old fork `main` that is neither upstream nor in `overlay/`
is simply absent, which is the point.

## Dependency order for the rebuild

- `14-js-tests-ci` **early** — it arms the JS test job that makes every other JS-side seam test bite
  (Rule 2).
- `15-harness-install` **before** `11-jj-pr-helper` — the jj binary rides in with the harness.
- `01-daytona-sizing` **before** `06-sandbox-connect` — the connect check depends on the 8 GiB
  snapshot.
- `06-sandbox-connect` **before** `04-child-result-delivery` and `05-provider-stall` — both need
  children reaching terminal on a connecting sandbox.
- `07-sidebar` is the highest reapply-cost line — careful/human reapply pass, not a rubber-stamp.
- `12-oneshot-popover`, `13-betterstack-template` are low priority — after the rest.

## Gate 1 — D1 migrations (Rule 3), check FIRST

- Confirm the prod D1 ledger. Every applied 9xxx id (currently 9000-9008, including 9005 and 9008)
  stays recorded and is **not re-added**.
- A rebuilt feature **reuses** its applied migration; it never re-adds the id or changes applied
  content.
- Any new fork migration takes the next free 9xxx id and sits after its upstream dependency in the
  `MIGRATIONS` array.

## Gate 2 — Idle-window tfvar (card 02)

- Assert `sandbox_inactivity_timeout_ms == 300000` is set in the prod tfvars.
- If missing, **set it**. Do not assume it is present — it is gitignored and local-only, so a fresh
  machine or a lost tfvars file drops it.

## Gate 3 — Queue-name length (card 03)

- `terraform validate` / `plan` must pass with no queue name exceeding 63 chars. The plan-time guard
  catches a dropped literal fix **before** any resource is touched. A green plan here is the real
  protection against a partial apply.

## Gate 4 — Connect smoke check (card 06), AFTER deploy

Wait for the snapshot rebuild first — see the sandbox-outage note below — then:

1. Create a session against a known repo, send a trivial prompt.
2. Assert the session reaches **connected within 90 s** and produces a **first response within 180
   s** (not just "sandbox created").
3. Assert idle-stop fires **4-7 min** later.
4. On any failure: the sync is NOT good. Block / roll back.

### Expected: a few-minutes sandbox-creation outage while the snapshot rebuilds

Any card that bumps `SANDBOX_VERSION` (01 sizing, 15 harness, 17 jj — any image change) makes the
apply **rebuild the Daytona base snapshot from scratch** (~4-5 min, the terraform
`null_resource.*_snapshot`). While it rebuilds and the control plane switches to the new version,
new sandboxes have no ready snapshot and fail to start. This is expected, not a regression — a live
session that failed to start during the window just needs a retry once the apply finishes. Run Gate
4 only **after** the apply reports the snapshot creation complete, or it will red on the rebuild
window itself.

## Gate 5 — Web custom domain (card 16), AFTER the web deploy

- Assert the web app's custom domain resolves **after** the `wrangler deploy` step, not just after
  the terraform apply, and that the served cert carries the hostname SAN. A dropped reapply of the
  `custom_domain` declaration takes the site to NXDOMAIN on the next deploy.

## Gate 6 — Fork ops notes in the root doc (card 18), at reapply time

- Grep the root doc (`CLAUDE.md` / `AGENTS.md`) for the ops markers: `SANDBOX_VERSION`,
  `gh run list --branch main`, the `production` environment gate, and the `9000` migration floor.
- All present -> pass. Any missing -> the sync overwrote the root doc with upstream's and the notes
  were not reapplied. Block and reapply from card 18.
- Deterministic, no live infra — run it alongside the rebuild, before deploy.

## Note

The connect path (snapshot sizing, the bridge SSE loop, the handshake, the jj PR helper) changes
almost entirely at sync time. Gate 4 is one live check that covers cards 01, 04, 05, 06, and 11 at
the moment they were reapplied. It is a deliberate, conscious relaxation of Rule 2's "automated seam
test" — so it must be run and read honestly, never skipped.
