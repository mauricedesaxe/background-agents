# Fragile-divergence registry (2026-09-12, post deep review)

What the next sync's reapply agent must know before touching anything. Sorted by fragility:
OVERRIDE-in-hot-files first. Classes: ADDITIVE (re-add, low risk), PATCH (edits an upstream function
— re-locate it), OVERRIDE (changes upstream behavior in place — check whether upstream shipped its
own version of the idea first).

| Behavior                           | Class          | Anchor                                             | Traffic | Reapply warning                                                                                                                                                                        |
| ---------------------------------- | -------------- | -------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context-reset hold                 | OVERRIDE+PATCH | message-queue dispatch checks; runtime.handleReady | HOT     | Widest surface (schema 51/52, dispatch, ready handler, proxy route, alarm, web). Upstream touched runtime.handler and message-repository post-base; re-check intent, not just anchors. |
| Archive stop-then-transition       | OVERRIDE       | session-lifecycle.handler archive()                | MED     | Upstream tests ASSERT the two 409 guards — locate and rewrite those test cases; do not just re-patch code.                                                                             |
| Once trigger (9001)                | ADDITIVE+PATCH | scheduler due-query; automation-store finalize     | HOT     | Upstream is actively changing scheduler+store+crud. Restore 9001 verbatim (id-locked, prod applied).                                                                                   |
| HIDE_SETTLED_ONCE_SQL              | PATCH          | automation-store list() conditions                 | HOT     | Keep the exclusion inside the query (pagination), reuse upstream's invocation-status aggregate.                                                                                        |
| Archive cascade + stranded prompts | PATCH          | session-status-service transition()                | MED     | Keep fan-out awaited, capped 50/5s; stranded-prompt failure pairs with cascade.                                                                                                        |
| Stop suppress-variant              | PATCH          | execution-stop-coordinator deliver()               | MED     | Also guards stop-recovery; dropping it resurrects queued work post-archive.                                                                                                            |
| Child-result delivery              | PATCH+ADDITIVE | DO fetch interception + childSessionUpdate         | MED     | Parse-clone BEFORE responding; edge-trigger on settled status only.                                                                                                                    |
| provider_retry + cap               | PATCH+ADDITIVE | bridge prompt loop                                 | MED     | Behavior, not just telemetry: bounds retries. Upstream may ship its own retry policy — conflict of intent.                                                                             |
| jj push refspec                    | PATCH          | push_operation refspec choice                      | MED     | Losing it re-publishes empty branches from jj-colocated checkouts.                                                                                                                     |
| Acknowledge route + BFF            | ADDITIVE       | session-runtime-proxy + web api dir                | MED     | Route rides LIFECYCLE; frozen catalog snapshots need regen on any route change.                                                                                                        |
| Idle-window 300000                 | PATCH (config) | variables.tf + worker default + ci env             | MED     | Verify-only; plan fails visibly if renamed.                                                                                                                                            |
| Fork ops notes + CI job            | PATCH (append) | AGENTS.md tail; ci.yml jobs                        | MED     | Sync overwrites the root doc; re-add the four markers, reword freely.                                                                                                                  |
| Queue-name gate                    | PATCH+ADDITIVE | queue literal + checks.tf                          | LOW     | Gate and literal must land in one commit or a partial apply returns (#327).                                                                                                            |
| Wrangler routes emission           | PATCH          | web-cloudflare.tf template                         | LOW     | Stringly template — a rewrite hides the interpolation. No backticks in plan-rendered strings (breaks the plan-comment step).                                                           |
| Daytona Resources 2/8/8            | PATCH          | toolchain.py snapshot params                       | LOW     | Verify the 8 GiB floor on the built snapshot, don't trust the arg.                                                                                                                     |
| jj + harness in images             | ADDITIVE       | toolchain.json + install phases                    | LOW     | Harness pin lives outside the tree; content-hash covers the files, verify the build picked it up.                                                                                      |
| Sidebar grouping/unread            | ADDITIVE+PATCH | sidebar tree + list composition                    | LOW     | Keep collapsed-by-default; no manual/auto filter control.                                                                                                                              |
| Toast allowlist                    | PATCH          | archiveSession error path                          | LOW     | Fragment allowlist; 5xx bodies stay generic.                                                                                                                                           |
| Inbox archived_lineage             | PATCH          | eligibility CTE                                    | MED     | Must keep re-rooting for deleted/Mine-filter ancestors; only archived lineage hides.                                                                                                   |

## Most likely to need redesign next sync (not re-locate)

1. Context-reset hold — if upstream ships its own recovery story, compare intent first.
2. Archive stop-then-transition — if upstream softens the guards itself, this becomes pure-subtract;
   retire instead of re-patch.
3. Once trigger — upstream's invocation model is actively moving under it.

## Round-7 findings (2026-09-12, forward-merge rehearsal + live measurements)

1. **UPSTREAM #1869 COLLIDES WITH CARD 20 (intent, highest priority).** Upstream added hard 409
   guards (skipped_cancelled, skipped_queued_work) inside canonical `archive()` — the exact behavior
   card 20 removes. In the rehearsed merge, a wedged session with undrained queued work 409s instead
   of archiving. Escalate to Alex before the next sync: either upstream's guard intent wins (retire
   card 20's wedge case) or the fork re-asserts.
2. **DRIFT RATE DOUBLED.** Rehearsal against upstream HEAD (12 commits past our snapshot, growing
   live): 8 conflicted files, 0.67 conflicts/commit, ~half judgment-grade. Extrapolated to a 2-week
   cycle: 13-20 conflicts. Shorten the sync interval to <=1 week.
3. **DO-schema migration IDs collided on first try** (both sides claimed 51). Reserve a fork-local
   ID range (or suffix strategy) for DO migrations, like D1's 9xxx floor.
4. **DO NOT remove the archived_lineage CTE.** Measured on the live Node host at 14k sessions: it is
   load-bearing for the planner — removing it collapses the inbox query ~100x (10.9s vs 91ms
   offline; list p50 60-105ms with it). Single-connection SQL is the concurrency ceiling; 5-tab
   polling stays under the Doherty bar at this scale.
5. Rehearsed-merge silent-auto-merge class: duplicated shared exports and signature ripples pass the
   merge and surface only in typecheck — typecheck is a required gate step of every future
   rehearsal.
