---
id: 01-daytona-sizing
title: Daytona sandbox sizing (2 CPU / 8 GiB / 8 GiB)
type: rebuild
priority: high
placement: snapshot
depends_on: []
origin: fork #329
discussion: https://github.com/mauricedesaxe/background-agents/issues/328#issuecomment-5339526201
---

## Requirement

Every session sandbox boots with enough memory to run the agent runtime. The Daytona base snapshot
is built at **2 vCPU / 8 GiB RAM / 8 GiB disk**. The runtime image is ~3.6 GiB, so the Daytona SDK
default of 1 vCPU / 1 GiB / 3 GiB kills the runtime on OOM before it opens its WebSocket. That
silent OOM is the #327 failure mode: a session shows "waiting for the sandbox runtime to connect"
forever, respawns every ~2 min, and never connects.

## Acceptance test (the contract)

Boot a real sandbox from the freshly built snapshot and assert the runtime WebSocket connects, OR
assert the snapshot's baked memory is >= an 8 GiB floor. A missed reapply then turns the sync gate
red instead of taking down prod. This is the same connect assertion as card `06-sandbox-connect`.

## Placement decision (durable)

The sizing lives **baked into the Daytona base snapshot**, set in the snapshot-build call. It cannot
live anywhere a blind sync survives better:

- The settings-UI CPU/memory fields are structurally inert on Daytona. Only the Vercel provider
  reads `cpuCores`/`memoryMib`. The Daytona provider strips them, because Daytona bakes resources
  into the snapshot and rejects a create that also specifies them. Vendor confirmed (Nikola,
  Daytona).
- No Daytona org-level default resources exist — org config is max caps only. Vendor confirmed. So
  there is no out-of-band lever.
- A tfvar saves the value but not the plumbing (the code that reads it is upstream-owned and gets
  overwritten), and it breaks the snapshot cache, which invalidates only on the build-file content
  changing.

So this is the Rule 1 case of "no sync-surviving config lever exists, therefore code plus a loud
test."

## Gotchas

- **Bump `SANDBOX_VERSION` in the same change.** The Daytona `source_hash` tracks only
  `.py/.js/.ts`, and the sizing change alone will not rebuild the snapshot without a version bump.
  Reapply and version bump travel together.
- **8 GiB RAM sits exactly at the org ceiling** (4 vCPU / 8 GiB / 10 GiB). No headroom above it. If
  a future image needs more, the org cap has to move first.
- Built-in Daytona snapshots do not fit (`daytona-medium` = 2/4/8, `daytona-large` = 4/8/10), so a
  custom snapshot is genuinely required.

## Dated evidence (2026-08-19, non-binding hints)

- Sizing set in `packages/daytona-infra/src/toolchain.py`, `create_base_snapshot`, as plain
  `Resources(cpu=2, memory=8, disk=8)` constants.
- The target is **8 GiB**, unambiguously: fork #329 shipped the 8 GiB sizing and comment 1 verified
  a prod sandbox boots at cpu2/mem8/disk8. The `SANDBOX_MEMORY_GIB = 4` in this checkout is only the
  stale pre-sync tree; clean upstream has no sizing at all, so the rebuild sets 8 from scratch, not
  a copy of any tree value.
- Provider strip: `packages/control-plane/src/sandbox/providers/daytona-provider.ts` (~line 85).
  Vercel read: `.../providers/vercel/provider.ts` (~line 675).
