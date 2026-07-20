# FORK.md

`mauricedesaxe/background-agents` is a **tracked fork** of
[`ColeMurray/background-agents`](https://github.com/ColeMurray/background-agents). This file records
what diverges on purpose, why each divergence exists, and the rules that keep a sync from silently
dropping one. It exists because that analysis has now been produced and lost twice, and a sync that
starts by re-deriving it starts by getting it wrong.

**Posture.** Upstream's architecture is adopted wholesale, including refactors that change no
behaviour on their own, because sharing their file shape is what keeps the next fix cheap.
Divergence is a listed exception, not an accumulating default. Anything not on the list below is
either a bug or a sync we have not done yet, and in both cases the answer is to take upstream's
version.

The convergence effort itself is tracked in
[#78](https://github.com/mauricedesaxe/background-agents/issues/78). Everything below was verified
against the tree, not against memory, at merge base `0a753421` and upstream pin `3e344bd0`. Both
move, so recompute them rather than trusting them: `git merge-base HEAD upstream/main`.

## The permanent divergences

Each of these is ours by design. A sync proposes changing one only with a reason that beats the one
recorded here.

### 1. The agent harness is installed into the sandbox image

Every provider's image build runs
`packages/sandbox-runtime/src/sandbox_runtime/scripts/install-harness.sh`, which clones
[`lazar-harness`](https://github.com/mauricedesaxe/lazar-harness) at a pinned commit and runs its
own `install.sh`. A sandbox agent then reads the same skills, agents, and philosophy a laptop agent
reads.

**Why.** The harness used to be copied into `sandbox_runtime/` by hand and it drifted: the sandbox's
philosophy carried a section the harness had already dropped, and its `clarity-reviewer` never got
the OpenCode dialect. Installing from the harness's own installer makes drift impossible. The pin is
a commit rather than a branch so two builds of the same source produce the same image.

`github-bot`'s PR review prompt (`packages/github-bot/src/prompts.ts`) invokes `lazar-review` by
name, which is the same divergence reaching a second package.

### 2. Daytona is the provider we actually run

Upstream ships several providers and we retain all of them; the ones we do not run diverge only
through the shared harness install. Daytona is the one under load here, so it carries fork-local
work: sizing applied to the snapshot rather than the create call, 4 GiB sandboxes with a readable
OOM cause, a 24-hour auto-archive default instead of 7 days, and a stop that retries across the
provider's state-change settle.

**Why.** Each of these was a production incident, not a preference. The 7-day auto-archive plus a
300 GiB account disk cap produced a recurring "timed out waiting to connect" outage. The 1 GiB
default OOM-killed OpenCode mid-build and surfaced as an unreadable stream error.

Providers we do not run are kept, not pruned, and their only local change is the one-line call into
`install-harness.sh` that every image build shares. Pruning them would create divergence to save
nothing.

### 3. The idle window is 7 minutes, not 15

`INACTIVITY_TIMEOUT_MS` and `INACTIVITY_EXTENSION_MS` in
`packages/control-plane/src/sandbox/lifecycle/decisions.ts` sum to 7 minutes where upstream's
`DEFAULT_INACTIVITY_CONFIG` sums to 15. The extension is bounded, so 7 is a hard upper bound rather
than something a connected client can extend indefinitely.

**Why.** Daytona resumes in place. Stopping early costs one resume on the next prompt and loses
nothing on disk, so a short window is close to free. Before this, roughly 94% of Daytona spend was
idle sandboxes.

### 4. Sandboxes can be archived

`supportsArchive`, `ArchiveConfig`, and `ArchiveResult` in
`packages/control-plane/src/sandbox/provider.ts` have no upstream counterpart at all. Archiving a
session archives its sandbox, and it cascades to the session's children. Pinned by
`packages/control-plane/test/integration/archive-cascade.test.ts`.

**Why.** A stopped Daytona sandbox still holds its disk against the account cap. Only archiving
frees it. Without this the cap is reached and new sandboxes stop booting.

### 5. Child sessions inherit the parent's model, and a zero cap disables fan-out

`packages/control-plane/src/routes/session-child-spawn.ts` resolves the model from the spawn context
rather than accepting a per-child override. A child-session cap of zero turns fan-out off instead of
falling back to a default. Pinned by
`packages/control-plane/test/integration/spawn-children.test.ts`.

**Why.** A fanned-out agent silently running a different model than the one chosen is expensive and
invisible. Every fanned-out agent also gets its own sandbox, so a zero cap is the only way to cap
that cost.

### 6. A session reattaches to its OpenCode conversation on resume

`packages/sandbox-runtime/src/sandbox_runtime/bridge.py` takes a control-plane-supplied
`opencodeSessionId` and reattaches, with a watchdog for messages that arrive before the sandbox is
ready. Pinned by `packages/sandbox-runtime/tests/test_bridge_session_reattach.py`.

**Why.** Without it, resuming a session starts a fresh conversation and the history is gone from the
agent's point of view while still being visible in the UI.

### 7. The SSE reader is decoupled from the WebSocket send

The bridge enqueues events onto a pump task rather than sending them inline, salvages partial output
when the stream drops, and reports OOM as a readable cause. Pinned by
`packages/sandbox-runtime/tests/test_event_pump.py` and `tests/test_entrypoint_oom.py`.

**Why.** A slow WebSocket send used to back-pressure the SSE reader until the connection died with
`incomplete chunked read`, losing everything the agent had produced in that turn.

### 8. jj is installed in the sandbox and the PR helper is jj-aware

`packages/daytona-infra/src/toolchain.py` installs a pinned, checksum-verified jj binary, and the
pull-request helper finalises `@` before pushing rather than pushing a detached git `HEAD`.

**Why.** The repos this fork works on are jj-colocated. Without the helper fix, a session branches
from a detached HEAD, pushes an empty branch, and opens no PR, with nothing in the output saying
why.

### 9. The tldraw whiteboard

A `BoardRoom` Durable Object, board routes, a live board editor in the session view, and a
`whiteboard` skill in the sandbox. Entirely fork-local: `packages/control-plane/src/board/`,
`packages/control-plane/src/routes/board.ts`, `packages/web/src/components/board-editor.tsx`, and
`packages/sandbox-runtime/src/sandbox_runtime/skills/whiteboard/`.

**Why.** Agents explain systems faster with a diagram than with prose, and a diagram the agent can
edit live beats an exported image.

### 10. Epoch and duration values are branded in control-plane

`packages/control-plane/src/time.ts` brands `EpochMs` and `DurationMs`, and time subtraction goes
through `elapsed()` so the result stays a `DurationMs` all the way to its comparison.

**Why.** `now > config.timeoutMs` compiles exactly as readily as `inactiveTime > config.timeoutMs`,
and only one of them means anything. An epoch timestamp compared against a 10-minute duration is
always true, which is a bug that reads correctly.

### 11. OpenRouter models are in the catalog

`packages/shared/src/models.ts` carries OpenRouter entries that upstream does not have, and the
sandbox sends OpenRouter reasoning effort as an OpenCode variant.

**Why.** Several models we want are only reachable through OpenRouter.

### 12. The automation forward is decoupled from bot dispatch

`packages/github-bot/src/index.ts` extracts the control-plane forward into its own
`forwardNormalizedEvent()`, which runs whether or not the built-in handler threw, where upstream
runs it inline after a handler that can skip it by throwing. Pinned by the fork-only
`packages/github-bot/test/webhook-forward.test.ts`.

**Why.** GitHub already has its 200 by then, because the work runs in `waitUntil`. A forward dropped
here is never redelivered, so the automation silently never fires and nothing records why.

A sync flattening this back inline is the specific risk: upstream keeps editing those same lines,
and its version of the payload fix (`286a82b2`) reads a local that our extraction moved out of
scope. That value is threaded in as a parameter instead. Take upstream's _choice of payload_ on that
line, never its _placement_.

## The reserved migration range

**Fork-local session-schema migrations use identifiers from `FORK_MIGRATION_ID_FLOOR` (9000) up.
Upstream owns everything below it, permanently.**

Session Durable Object migrations live in `packages/control-plane/src/session/schema.ts` and are
applied by identifier. `applyMigrations()` records each applied id in `_schema_migrations` and skips
any id already recorded. There is no content check and no idempotency guard, so an id is a claim on
a slot rather than a description of a change.

**The reserved range is an identity namespace, not an ordering mechanism.** This is the easiest
thing to misread about it. `applyMigrations()` is a set-membership check —
`if (applied.has(migration.id)) continue` — with no sort and no high-water mark. Execution order is
the literal array order of `MIGRATIONS`. So a high id does not mean "runs last", and a fork-local
migration that depends on an upstream one has to be **positioned after it in the array**; an
identifier above the floor buys no sequencing on its own. The range exists so the two sides never
claim the same slot, and it does nothing else.

That makes a collision silent rather than loud. Shared history ends at migration 34. Both sides then
claimed 35 and 36 for entirely different schema changes:

| id  | ours                              | upstream's                         |
| --- | --------------------------------- | ---------------------------------- |
| 35  | `stop_unreconciled_at` on sandbox | create the `attachments` table     |
| 36  | `stop_unreconciled_provider_id`   | durable latest session diff bundle |

A deployed session store that has already run our 35 and 36 has those ids in `_schema_migrations`.
Taking upstream's versions would leave the runner skipping both, so `attachments` and the diff table
would never be created, and the querying code would fail at runtime against a store that reports
itself fully migrated. Nothing in CI catches this, because a fresh store in a test has no rows to
skip.

**The move is done** ([#81](https://github.com/mauricedesaxe/background-agents/issues/81)). Our two
migrations were rewritten as one guarded operation at **9001**, which inspects the store and no-ops
where the change is already present, so a store carrying the old identifiers ends in the same shape
as a fresh one. Ids 35 and 36 are released back to upstream, and taking upstream's schema changes is
no longer blocked.

Renumbering the source was only half of it, because deployed stores still carry rows at 35 and 36.
`releaseRetiredIdentifiers()` deletes those rows, and it runs **before** the runner reads the table,
so upstream's versions apply on the same wake rather than the next one. A session idle across both
deploys would otherwise serve an entire Durable Object lifetime without them.

The part worth not re-deriving is what it keys on. It releases the ids in `RETIRED_LOW_IDS` that
`MIGRATIONS` no longer claims, not a marker row recording that the move ran:

```ts
RETIRED_LOW_IDS.filter((id) => !MIGRATIONS.some((m) => m.id === id));
```

That makes it rollback-proof and self-disabling. A marker row was tried first and is wrong: rolling
back to code that still defines 35 and 36 re-runs them, `runMigration` swallows the resulting
`duplicate column` error, and the rows come back indistinguishable from upstream's. A marker check
would then skip upstream's real migrations forever. Keying on what `MIGRATIONS` claims means every
roll-forward clears the rows again, and adopting upstream's 35 and 36 turns the release off on its
own, because they are claimed again.

## Divergence by package

The shape matters when sequencing a sync. Ordered by how much diverges, heaviest first:

| Package              | What diverges                                             |
| -------------------- | --------------------------------------------------------- |
| `control-plane`      | Nearly all of our behaviour. By far the heaviest package. |
| `sandbox-runtime`    | Bridge, harness install, whiteboard skill                 |
| `web`                | Board UI, archived-subtree sidebar, settings              |
| `shared`             | Model catalog and artifact types                          |
| `github-bot`         | Review prompt sources `lazar-review`; forward decoupling  |
| `daytona-infra`      | Toolchain: jj, sandbox version                            |
| `modal-infra`        | The harness install call in the image build, nothing else |
| `opencomputer-infra` | The harness install call in the image build, nothing else |
| `slack-bot`          | Thread-pagination fan-out fix and its `truncated` warning |
| `linear-bot`         | **Nothing.** Take upstream wholesale.                     |

Recompute the counts rather than remembering them, since any commit changes them:

```sh
git diff --name-only "$(git merge-base HEAD upstream/main)"..HEAD | grep '^packages/'
```

`linear-bot` is the last package that can be taken whole without a merge, and that stays true only
until someone edits it.

`slack-bot` was in the same position until
[#83](https://github.com/mauricedesaxe/background-agents/issues/83), and how it left is the useful
part. #83 was written to take both bots wholesale and was sequenced early for exactly that reason,
but #82 landed a fan-out fix in `slack-bot` first, so by the time #83 ran the window had already
closed. The wholesale take was correct for `linear-bot`, whose tree hash still matched the merge
base, and wrong for `slack-bot`, which would have silently dropped the fix. **Prove divergence per
package at the moment you sync, rather than trusting this table**, which records the last sync and
not today.

What diverges in `slack-bot` is one behaviour in `events/message-handler.ts`. `getThreadMessages`
pages oldest-first and stops at a page cap, so a long enough thread loses its _newest_ messages,
which are the ones the history wants. Our `shared` client reports that as `truncated` and the
handler warns on it; upstream has no such signal and its doc comment asserted the opposite. Author
resolution is also bounded to the ten retained messages, which upstream now does too, but nothing
upstream pins it. Both are pinned by tests in `packages/slack-bot/src/index.test.ts` that fail when
either behaviour is removed.

## Test files are merged by hand, never taken wholesale

**This applies to every package, every time.** If a port needs one of our tests edited to go green,
the port dropped a behaviour. That is the signal, not a stale test.

The failure mode it prevents is the only genuinely silent one in a sync. Upstream's tests pass
against upstream's behaviour. Replacing one of our test files with theirs therefore goes green at
the exact moment it deletes the evidence that our behaviour ever existed, and nothing anywhere
reports a loss. Everything else in a sync fails as a conflict or a red test.

Roughly half of everything we have diverged is a test file, in both `control-plane` and
`sandbox-runtime`. Those files are where the idle window, the pending-message watchdog, unreconciled
stops, session reattachment, archive cascade, and child model inheritance are actually pinned. They
are the divergence, not documentation of it.

Our tests survive upstream's refactors because they are coupled to collaborator interfaces rather
than to how those collaborators are constructed, and construction is what a dependency-injection
refactor changes. Keep new tests on that side of the line.

## Fork-only files

**Fork-only files stay under `packages/`.** There are two deliberate exceptions outside it, and both
earn it the same way: upstream will never have the file, so it can never conflict during a sync.

- **This document.** The divergence analysis has been produced and lost twice, so it is committed.
- **`.claude/agents/`.** Repo-local reviewer agents, auto-discovered by `lazar-review` locally and
  by the PR review bot. `fork-divergence-reviewer.md` is the one that keeps this document honest by
  checking its claims against the tree on every PR that touches them.

General harness configuration is still not committed here, and the exception above is narrow: a
reviewer that encodes _this repo's_ invariants has nowhere else to live, because a global agent
cannot know them. Tracker configuration and per-repo conventions stay in a machine-local note
outside the repo. A file upstream does not have can never conflict, but it is still a file every
future sync has to reason about, so the count stays low on purpose.
