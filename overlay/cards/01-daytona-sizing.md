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

- The settings-UI CPU/memory fields are structurally inert on Daytona. Only one provider reads the
  requested sizing from session settings; the Daytona provider strips it, because Daytona bakes
  resources into the snapshot and rejects a create that also specifies them. Vendor confirmed
  (Nikola, Daytona).
- No Daytona org-level default resources exist — org config is max caps only. Vendor confirmed. So
  there is no out-of-band lever.
- A deployment variable saves the value but not the plumbing (the code that reads it is
  upstream-owned and gets overwritten), and it breaks the snapshot cache, which invalidates only on
  the hashed build inputs changing.

So this is the Rule 1 case of "no sync-surviving config lever exists, therefore code plus a loud
test."

## Durable constraints

- **Image changes propagate through the snapshot content hash.** The hash is computed over the
  declared payload roots, so a change inside them invalidates the snapshot on its own, and a change
  outside them ships nothing even with a green pipeline. There is no manual version lever: the
  image's version stamp is a runtime marker, not a propagation trigger. (This supersedes the
  2026-08-19 version-bump recipe — see Provenance.)
- **8 GiB RAM sits exactly at the org ceiling** (4 vCPU / 8 GiB / 10 GiB). No headroom above it. If
  a future image needs more, the org cap has to move first.
- Built-in Daytona snapshots do not fit (medium 2/4/8, large 4/8/10), so a custom snapshot is
  genuinely required.

## Provenance

The sizing shipped fork-side in #329 (2026-08) and comment 1 verified a prod sandbox booting at 2
CPU / 8 GiB / 8 GiB, so the target is 8 GiB unambiguously; clean upstream has no sizing at all and
the blind sync wipes the fix every cycle, so the rebuild sets 8 from scratch. The 2026-08-19 card
carried file anchors into the snapshot-build call and a "bump the image version stamp in the same
change" recipe; both were dropped in the 2026-09-11 conversion — the anchors mapped the pre-sync
tree, and the recipe is superseded by the content-hash propagation recorded in the fork ops notes.
