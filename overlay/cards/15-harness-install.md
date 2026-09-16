---
id: 15-harness-install
title: lazar-harness skills through managed skills
type: rebuild
priority: high
placement: upstream-code + lazar-harness
depends_on: []
origin: fork
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5341478917
---

## Requirement

The sandbox coding agent receives lazar-harness skills through the control plane's managed-skills
catalog. The harness repository's canonical `skills/<name>` directories are sandbox-ready and
portable; each directory is imported as its own catalog entry so OpenCode can discover the canonical
names. The entries are globally assigned so they apply across repositories, and the complete set can
be selected with a personal profile.

Do **not** run the harness installer while building a sandbox image and do not bake either managed
skills destination into a snapshot. `ManagedSkillsMaterializer` owns that complete directory and
replaces it on every boot. A baked directory both loses to that replacement and can make overlayfs
reject the boot-time directory swap.

## Acceptance test (the contract)

A session selecting the Lazar Harness profile materializes the pinned managed revisions and can
invoke a `lazar-*` skill. A session selecting no managed skills contains none of them. Sandbox boot
does not report a managed/local collision for the imported names.

## Placement decision (durable)

- The generic import, profile, resolution, and materialization mechanisms stay in the upstream-owned
  managed-skills implementation.
- The single authored source belongs in the external `lazar-harness` repository under
  `skills/<name>`. Imports may warn when they omit host-specific frontmatter; there is no second
  generated skill collection or frontmatter overlay to keep synchronized.
- Catalog entries record the source commit and content digests. Updating the harness is an explicit
  preview-and-reimport operation; image rebuilds are unrelated.
- Managed skills install skills only. Harness rules, hooks, agents, binaries, and OpenCode command
  adapters require separate product decisions and must not be smuggled back into the image bake.

## Gotcha (same as cards 01, 11)

The former build-time installer created the exact destination that managed skills replace. In an
overlay lower layer that directory cannot necessarily be renamed; the resulting `EXDEV` killed
sandbox boot. PR #383 retained a copy fallback for restored snapshots, and PR #384 removed the
installer, image phase, pin, wiring, and smoke assertions. Do not reconstruct them during a blind
sync. The managed source ref changes through re-import and does not participate in the Daytona image
hash.

## Provenance

Fork-only. The image-baked implementation was retired by PR #384 after the managed-skills rollout.
