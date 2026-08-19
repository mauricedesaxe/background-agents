---
id: 18-fork-ops-notes
title: Fork ops notes in the root agent doc
type: rebuild
priority: medium
placement: upstream-code
depends_on: []
origin: fork CLAUDE.md CI/CD section; issues #75, #94
discussion: https://github.com/mauricedesaxe/background-agents/issues/328
---

## Requirement

The root agent-facing doc (`CLAUDE.md`, symlinked/aliased as `AGENTS.md`) that every sandbox and
laptop agent reads carries the fork's deploy, CI, and migration gotchas. A blind sync overwrites the
root doc with upstream's, which knows nothing about this deployment, so these notes vanish unless
they are reapplied. This is the same drop that took `docs/FORK.md` and the fork's own CLAUDE.md off
`main` — the difference is that the divergence docs were superseded by `overlay/`, while these
operational notes have no other home a sandbox agent reads.

Each note below is a production fact an agent needs to ship correctly on this fork. They must be
present in the root doc after every sync. Reword freely to fit upstream's doc shape; keep the facts
and the issue references.

- **Deploy path.** Merging to `main` triggers `terraform.yml`. Plan always runs; **Apply is gated on
  the `production` environment** (required reviewer). Terraform deploys the control-plane, the D1
  migrations, and the web app when `web_platform = "cloudflare"`. Vercel deploys the web app when
  `web_platform = "vercel"`. Sandbox providers deploy via the same Terraform apply. **Daytona is the
  provider this deployment runs.**
- **A merge can produce zero runs (#75).** A rebase-merge has been observed producing no workflow
  runs at all, leaving the change on `main` looking deployed with nothing to approve. Confirm with
  `gh run list --branch main` after merging; force with `gh workflow run terraform.yml --ref main`.
- **A harness or skills change ships nothing without a `SANDBOX_VERSION` bump (#94).** The harness
  installs at image-build time, but Daytona's `source_hash` only covers `.py`, `.js`, and `.ts`, so
  editing `HARNESS_REF` in `install-harness.sh` does not invalidate the snapshot. `SANDBOX_VERSION`
  has to move too, and an apply has to rebuild the snapshot, before a harness change reaches a
  sandbox. Modal and Vercel filter by the same extension list. OpenComputer is the exception — its
  hash covers every non-cache file under the sandbox-runtime source.
- **A healthy post-deploy plan is not empty.** `always_run = timestamp()` means every worker always
  shows as replaced. The signal to look for is that nothing says `will be created`.
- **Fork-local D1 migrations start at id 9000.** See `overlay/rules.md` Rule 3 for the full rule;
  the root doc only needs to point an agent at the reserved range so it does not reuse an upstream
  id. Do not restate the rule here.

## Acceptance test (the contract)

After a sync, the root doc contains the ops markers. Gate 6 in `overlay/runbook.md` greps the root
doc for `SANDBOX_VERSION`, `gh run list --branch main`, `production` environment, and the `9000`
migration floor. All present -> pass. Any missing -> the sync dropped the notes; block / reapply.
The check is a deterministic grep, so it runs at reapply time with no live infra.

## Placement decision (durable)

- The notes are prose in the **upstream-owned root doc**, reapplied each sync. Upstream provides no
  base for them, so this card carries the canonical text; the root doc is the disposable copy.
- They live in the **root doc specifically**, not `overlay/`, because that is the doc a sandbox
  agent reads. A note in `overlay/` survives the sync but never reaches a sandbox agent, which is
  the whole reason a dropped `SANDBOX_VERSION` note (#94) silently ships nothing.
- The migration-floor line is a **pointer**, not a copy — the rule's canonical home is
  `overlay/rules.md` Rule 3. Restating it here would be the double state the overlay exists to
  avoid.

## Dated evidence (2026-08-20, non-binding hints)

- These notes were the `## CI/CD` and `## Key Gotchas` sections of the fork's pre-sync `CLAUDE.md`,
  which the phase-3 blind sync overwrote with upstream's. Generic package facts (build order,
  PKCS#8, DO two-phase, no `wrangler.toml`, Modal deploy quirks) are upstream's already and are not
  this card's concern — only the deploy/CI/migration facts above are fork-only.
