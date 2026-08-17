# FORK.md

`mauricedesaxe/background-agents` is a **tracked fork** of
[`ColeMurray/background-agents`](https://github.com/ColeMurray/background-agents). This file is the
**canonical downstream patch record**: the single inventory of every retained downstream capability
and patch, why each one exists, and the rules that keep a sync from silently dropping one. It exists
because that analysis has now been produced and lost twice, and a sync that starts by re-deriving it
starts by getting it wrong.

**Posture.** Upstream's architecture is adopted wholesale, including refactors that change no
behaviour on their own, because sharing their file shape is what keeps the next fix cheap.
Divergence is a listed exception, not an accumulating default. Anything not on the list below is
either a bug or a sync we have not done yet, and in both cases the answer is to take upstream's
version.

The convergence effort itself is tracked in
[#78](https://github.com/mauricedesaxe/background-agents/issues/78), and its decision map in
[#263](https://github.com/mauricedesaxe/background-agents/issues/263). Everything below was verified
against the tree, not against memory, at merge base `0a753421`. The baseline on 2026-08-07 was fork
`3361bd8d`, upstream `b63d0175`, and the
[#291 continuity probe](https://github.com/mauricedesaxe/background-agents/issues/291) verified the
bridge seams against upstream HEAD `b28cfa7`. Both move, so recompute them rather than trusting
them: `git merge-base HEAD upstream/main`.

## How to read this record

Every retained capability or patch below carries the same six fields. A field that genuinely does
not apply is marked `none`; a stale one is marked `recompute`.

- **Status.** One of `retained` (keep as-is), `retained-candidate` (kept but a named removal
  candidate), `upstream-owned` (upstream now owns the behaviour; we keep only a regression guard),
  or `config` (moved to a verified configuration value).
- **Provenance.** The fork commit(s) and issue(s) that introduced it.
- **Upstream link.** The upstream issue/PR, if one reports or fixes the same thing. `none` means no
  known upstream signal today; what to do when upstream later moves is the removal condition's job.
- **Acceptance ownership.** The test that proves the retained behaviour exists. On a sync, this test
  is the gate: if a port needs it edited to go green, the port dropped a behaviour.
- **Removal condition.** The concrete event that lets us delete this entry, stated so it is
  checkable rather than vibes.
- **Last-verified upstream SHA.** The upstream commit this entry was last checked against.

**Canonical rationale vs. the sync runbook.** This file is the canonical _what and why_. The
operational _how_ of running a whole-upstream sync (detection, throwaway integration, review,
acceptance, promotion, recorded history) is a different artifact with a different lifecycle and
belongs in the sync-method work
[#267](https://github.com/mauricedesaxe/background-agents/issues/267), not here. Keep FORK.md to
what a sync must not silently drop; the runbook is how a sync moves a range, and it already has a
long decision handoff in #267's comments. Do not let the runbook's machinery bloat this file.

## The permanent divergences

Each of these is ours by design. A sync proposes changing one only with a reason that beats the one
recorded here.

### 1. The agent harness is installed into the sandbox image

**Status:** retained · **Provenance:** fork `a508e47` (pin-invalidation note) and every subsequent
harness pin bump (e.g. `be76407`, `680d6d1`, `53a21a7`, `137b266`) · **Upstream link:** none ·
**Acceptance ownership:** `packages/sandbox-runtime/tests/test_install_harness.py` · **Removal
condition:** none — the harness has no upstream counterpart by definition · **Last-verified upstream
SHA:** `b63d0175`.

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

Modal, Vercel, and OpenComputer include the installer in their image fingerprints. Daytona excludes
shell files, so each harness pin bump also advances its `SANDBOX_VERSION`. This is why the four
post-baseline `chore(sandbox-runtime)` pin bumps (`be76407`, `680d6d1`, `53a21a7`, `137b266`) are
not separate divergences: they move the same retained pin on entry #1. A harness pin bump alone
ships nothing on Daytona until `SANDBOX_VERSION` moves too and an apply rebuilds the snapshot (issue
#94).

### 2. Daytona is the provider we actually run

**Status:** retained · **Provenance:** fork `53a6950` (pin provider identity for stop retries),
`d3fdd62` (serialize stop settlement before resume), `c797d0e3` (snapshot sizing) · **Upstream
link:** none · **Acceptance ownership:** Daytona integration tests · **Removal condition:** none —
the provider under load carries this by definition · **Last-verified upstream SHA:** `b63d0175`.

Upstream ships several providers and we retain all of them; the ones we do not run diverge only
through the shared harness install. Daytona is the one under load here, so it carries fork-local
work: sizing applied to the snapshot rather than the create call, 8 GiB memory and 8 GiB disk per
sandbox, a readable OOM cause, a 24-hour auto-archive default instead of 7 days, and a stop that
retries across the provider's state-change settle. The control plane remains `stopping` until
Daytona reports the provider sandbox as stopped, so a prompt joins that transition instead of racing
it with a second stop. Failed-stop reconciliation pins the original provider ID so a retry cannot
stop a replacement sandbox. A restarted Daytona supervisor recognizes the persisted OpenCode session
as a resume, preserving local work and skipping setup hooks instead of resetting the branch to its
remote tip.

**Why.** Each of these was a production incident, not a preference. The 7-day auto-archive plus a
300 GiB account disk cap produced a recurring "timed out waiting to connect" outage. The 1 GiB
memory default OOM-killed OpenCode mid-build and surfaced as an unreadable stream error. The 3 GiB
disk default filled during ordinary dependency installs and made OpenCode's SQLite writes fail. The
later 4 GiB allocation reached its cgroup limit during ordinary review work, which killed the agent
processes while the supervisor survived. The 8 GiB allocation gives that workload headroom.

Providers we do not run are kept, not pruned, and their only local change is the one-line call into
`install-harness.sh` that every image build shares. Pruning them would create divergence to save
nothing.

### 3. The idle window is 7 minutes, not 15

**Status:** retained · **Provenance:** fork (idle-window change) · **Upstream link:** none ·
**Acceptance ownership:** control-plane inactivity tests · **Removal condition:** none while the
cost of an idle Daytona sandbox stays — the short window is priced into the provider economics ·
**Last-verified upstream SHA:** `b63d0175`.

`INACTIVITY_TIMEOUT_MS` and `INACTIVITY_EXTENSION_MS` in
`packages/control-plane/src/sandbox/lifecycle/decisions.ts` sum to 7 minutes where upstream's
`DEFAULT_INACTIVITY_CONFIG` sums to 15. The extension is bounded, so 7 is a hard upper bound rather
than something a connected client can extend indefinitely.

**Why.** Daytona resumes in place. Stopping early costs one resume on the next prompt and loses
nothing on disk, so a short window is close to free. Before this, roughly 94% of Daytona spend was
idle sandboxes.

### 4. Sandboxes can be archived

**Status:** retained · **Provenance:** fork (archive cascade; unified later with the
last-active-overlay work `fc5eea9`, `3361bd8`; activity-aware retry `77459fe`) · **Upstream link:**
none · **Acceptance ownership:** `packages/control-plane/test/integration/archive-cascade.test.ts`
and the auto-archive cases in `packages/control-plane/src/session/session-status-service.test.ts` ·
**Removal condition:** adopt upstream only if it gains an equivalent archive primitive at the same
semantics; until then keep · **Last-verified upstream SHA:** `b63d0175`.

`supportsArchive`, `ArchiveConfig`, and `ArchiveResult` in
`packages/control-plane/src/sandbox/provider.ts` have no upstream counterpart at all. Archiving a
session archives its sandbox, and it cascades to the session's children. Pinned by
`packages/control-plane/test/integration/archive-cascade.test.ts`.

**Why.** A stopped Daytona sandbox still holds its disk against the account cap. Only archiving
frees it. Without this the cap is reached and new sandboxes stop booting.

**What counts as "last active" is one shared set.** The sandbox inactivity timer and the
auto-archive timer read a single activity definition from
`packages/control-plane/src/session/session-activity.ts` instead of each tracking a different event
set. Activity records through one choke point that refreshes the sandbox's `last_activity` and, when
the session is terminal, extends `terminal_at` forward; `child_session_update` does the same via the
status service. Otherwise a terminal session still receiving artifacts, tool calls, git syncs, or
child reports would archive 12 hours after it first went terminal. This is retained behavior in its
own right, not just a config value, and was unified with the child-result delivery work (`fc5eea9`,
`3361bd8`). A failed automatic archive clears its explicit retry marker so the retry alarm rechecks
the extended deadline; cascade archive retries retain their retry marker.

### 5. Child sessions inherit the parent's model, and a zero cap disables fan-out

**Status:** retained · **Provenance:** fork (child spawn model inheritance) · **Upstream link:**
none · **Acceptance ownership:** `packages/control-plane/test/integration/spawn-children.test.ts` ·
**Removal condition:** none while silent model drift on fanned-out agents has a real cost ·
**Last-verified upstream SHA:** `b63d0175`.

`packages/control-plane/src/routes/session-child-spawn.ts` resolves the model from the spawn context
rather than accepting a per-child override. A child-session cap of zero turns fan-out off instead of
falling back to a default. Pinned by
`packages/control-plane/test/integration/spawn-children.test.ts`.

**Why.** A fanned-out agent silently running a different model than the one chosen is expensive and
invisible. Every fanned-out agent also gets its own sandbox, so a zero cap is the only way to cap
that cost.

### 6. A session reattaches on the same sandbox and fails closed after permanent loss

**Status:** retained-candidate, sized by the
[#291 measurement](https://github.com/mauricedesaxe/background-agents/issues/291) · **Provenance:**
fork `4da3fec3` (reattach OpenCode session on resume) · **Upstream link:** none for the retained
core — upstream now owns several inner pieces natively · **Acceptance ownership:**
`packages/sandbox-runtime/tests/test_bridge_session_reattach.py`,
`packages/control-plane/test/integration/websocket-sandbox.test.ts` · **Removal condition:** reduce
this entry to the genuinely-retained core below once upstream's split modules (`prompt_stream.py`,
`event_forwarder.py`, `child_activity.py`, `opencode_identifier.py`) are adopted · **Last-verified
upstream SHA:** `b28cfa7` (probe).

`packages/sandbox-runtime/src/sandbox_runtime/bridge.py` takes a control-plane-supplied
`opencodeSessionId` and reattaches, with a watchdog for messages that arrive before the sandbox is
ready. The bridge verifies the expected session through OpenCode before reporting readiness. An
authoritative session ID that is missing from OpenCode fails the resume rather than silently
replacing the conversation. The control plane fails queued work and settles the pinned provider
object before acknowledging that terminal result. Daytona stop, archive, supervisor restart, and
bridge restart retain the same provider object and disk, so its workspace and native OpenCode
conversation remain available while that object exists. The bridge keeps its SSE stream attached
after OpenCode emits the first typed `ContextOverflowError`, allowing OpenCode's native compaction
and replay to finish. Repeated or unrelated errors remain terminal. Automatic overflow recovery
persists and renders only its message-scoped `context_compacted` completion. Manual compaction
persists its start and terminal outcome as timeline events: starts and completions render neutrally,
while failures render destructively. The session UI exposes manual compaction only while idle. Its
dedicated protocol command subscribes to OpenCode events before calling
`POST /session/:id/summarize` with the selected model's flat, case-sensitive `providerID` and
`modelID`. Only `session.compacted` is success. `session.error` is a failure even when the HTTP
response is `200`, and a five-minute deadline aborts OpenCode before the bridge reports a timeout.
The operation stays attached to the existing OpenCode session and is stored outside the prompt
transcript. The native endpoint behavior and later message lineage were
[probed against pinned OpenCode 1.14.41](https://github.com/mauricedesaxe/background-agents/issues/129#issuecomment-5044195365).

The
[#291 probe](https://github.com/mauricedesaxe/background-agents/issues/291#issuecomment-5224806472)
is the sizes for this entry. Upstream `b28cfa7` decomposed `bridge.py` into four modules the fork
does not have, so the fork's 2654-line bridge is largely an inline transcription of code upstream
now owns natively. Of the 1470-line gap, roughly 600 LOC is genuinely retained across five seams,
roughly 600 is upstream-native-now (droppable by adopting upstream's split modules), and the rest is
refactor noise. The genuinely-retained seams, and their removal conditions:

- **Reattach fail-closed** (~140 LOC): env-supplied `opencodeSessionId`, verify-before-ready,
  `context_unavailable` gating. Mixed with native upstream reattach. Keep until upstream carries the
  same verify-before-ready and fail-closed semantics.
- **Manual compaction** (`summarize`, ~110 LOC): upstream has no `summarize` command, verified
  absent (`b28cfa7`). Keep.
- **Event-pump + OOM cgroup reader** (~130 LOC): the fork's `EventPump` is a pump task with
  eviction; upstream's `BufferedEventForwarder` buffers inline, not a pump. Keep (this is entry #7).
- **jj-aware PR helper** (~150 LOC): the jj core; see entry #8.
- **Provider-retry / usage-limit surfacing** (~40 LOC): the seams in entries #24 and #25.

Mixed-version deploys retain a narrow compatibility sink for old bridges. Legacy checkpoint uploads
are checksummed and discarded, checkpoint lifecycle events are acknowledged without persistence or
broadcast, and downloads return `404`. This prevents retries during rollout without making
checkpoints part of the current protocol or recovery path. Acceptance ownership: the legacy
checkpoint compatibility cases in
`packages/control-plane/test/integration/legacy-checkpoint-compat.test.ts`, which `097afc6` reworked
to stop depending on unrelated provider timing.

Automatic overflow recovery is pinned by
`packages/sandbox-runtime/scripts/reproduce_context_overflow.py` and the compaction cases in
`test_bridge_sse.py`. Manual compaction is pinned by `test_bridge_compaction.py` and the
control-plane WebSocket integration tests. Same-sandbox continuity and permanent-loss handling are
pinned by `packages/sandbox-runtime/tests/test_bridge_session_reattach.py` and
`packages/control-plane/test/integration/websocket-sandbox.test.ts`.

**Why.** Without reattachment, resuming starts a fresh conversation and the history is gone from the
agent's point of view while still being visible in the UI. Without overflow deferral, the bridge
reports failure and disconnects while OpenCode successfully compacts and recovers in the same
session, so the recovered response never reaches the user. Permanent provider-object loss removes
both unpublished workspace state and the native conversation database. Automatic reconstruction
proved less reliable than failing clearly before model or tool execution, so a replacement sandbox
does not download or import native conversation checkpoints.

### 7. The SSE reader is decoupled from the WebSocket send

**Status:** retained · **Provenance:** fork (event pump) · **Upstream link:** none — upstream's
`BufferedEventForwarder` is a different mechanism · **Acceptance ownership:**
`packages/sandbox-runtime/tests/test_event_pump.py` and `tests/test_entrypoint_oom.py` · **Removal
condition:** adopt upstream's forwarder only if it proves equivalent at the pump's eviction
semantics; it is not today (`b28cfa7`) · **Last-verified upstream SHA:** `b28cfa7`.

The bridge enqueues events onto a pump task rather than sending them inline, salvages partial output
when the stream drops, and reports OOM as a readable cause. Pinned by
`packages/sandbox-runtime/tests/test_event_pump.py` and `tests/test_entrypoint_oom.py`.

**Why.** A slow WebSocket send used to back-pressure the SSE reader until the connection died with
`incomplete chunked read`, losing everything the agent had produced in that turn.

### 8. jj is installed in the sandbox and the PR helper is jj-aware

**Status:** retained-candidate · **Provenance:** fork · **Upstream link:** none · **Acceptance
ownership:** `packages/sandbox-runtime` PR-helper tests · **Removal condition:** none while the
repos this fork works on stay jj-colocated · **Last-verified upstream SHA:** `b28cfa7`.

`packages/daytona-infra/src/toolchain.py` installs a pinned, checksum-verified jj binary, and the
pull-request helper finalises `@` before pushing rather than pushing a detached git `HEAD`.

**Why.** The repos this fork works on are jj-colocated. Without the helper fix, a session branches
from a detached HEAD, pushes an empty branch, and opens no PR, with nothing in the output saying
why. Per #291, the jj core (`_run_jj`, `_jj_working_copy_has_changes`, no-commits-beyond-trunk) is
the retained ~150 LOC; basic git push is native upstream.

### 9. The tldraw whiteboard

**Status:** retained · **Provenance:** fork (`754ebbc`) · **Upstream link:** none · **Acceptance
ownership:** control-plane + web board tests · **Removal condition:** none while the diagram-first
explanation workflow is used · **Last-verified upstream SHA:** `b63d0175`.

A `BoardRoom` Durable Object, board routes, a live board editor in the session view, and a
`whiteboard` skill in the sandbox. Agents inspect the same document through short-lived read-only
URLs rendered by `packages/web/src/components/board-inspection.tsx`; the sandbox's `board inspect`
command captures that browser surface. Entirely fork-local: `packages/control-plane/src/board/`,
`packages/control-plane/src/routes/board.ts`, `packages/web/src/components/board-*.tsx`,
`packages/web/src/app/board/inspect/`, `packages/sandbox-runtime/src/sandbox_runtime/bin/board.js`,
and `packages/sandbox-runtime/src/sandbox_runtime/skills/whiteboard/`.

**Why.** Agents explain systems faster with a diagram than with prose. The rendered inspection path
lets them catch clipping, layering, and spacing defects before asking the user to review the live
board.

### 10. Epoch and duration values are branded in control-plane

**Status:** retained · **Provenance:** fork (`5c3e6c5` brands service nonce expiry) · **Upstream
link:** none · **Acceptance ownership:** typecheck · **Removal condition:** none — a compile-time
guard worth keeping · **Last-verified upstream SHA:** `b63d0175`.

`packages/control-plane/src/time.ts` brands `EpochMs` and `DurationMs`, and time subtraction goes
through `elapsed()` so the result stays a `DurationMs` all the way to its comparison.

**Why.** `now > config.timeoutMs` compiles exactly as readily as `inactiveTime > config.timeoutMs`,
and only one of them means anything. An epoch timestamp compared against a 10-minute duration is
always true, which is a bug that reads correctly.

### 11. OpenRouter models are in the catalog

**Status:** retained-candidate · **Provenance:** fork `339aca6` (add DeepSeek V4 Flash 0731),
`9d42d02` (remove unsupported DeepSeek reasoning variants), and the retained-inventory amendment
below · **Upstream link:** none — upstream has no OpenRouter entries · **Acceptance ownership:**
`packages/shared/src/models.test.ts` · **Removal condition:** if OpenRouter/DeepSeek stops being
used; live now · **Last-verified upstream SHA:** `b63d0175`.

`packages/shared/src/models.ts` carries OpenRouter entries that upstream does not have. Reasoning
effort is exposed only for models where pinned OpenCode defines matching variants; it defines none
for DeepSeek V4 Flash 0731.

**Why.** Several models we want are only reachable through OpenRouter.

**Retention, not drop.** The retained-inventory issue #264 originally listed OpenRouter under `drop`
("not used"). That is amended: OpenRouter and DeepSeek are retained today because DeepSeek V4 Flash
and other models are only reachable through it. It stays a removal candidate if it stops being used,
but it is live now, so a reconstructor must not delete it.

### 12. The automation forward is decoupled from bot dispatch

**Status:** retained · **Provenance:** fork (github-bot forward extraction) · **Upstream link:**
none · **Acceptance ownership:** the fork-only `packages/github-bot/test/webhook-forward.test.ts` ·
**Removal condition:** adopt upstream's inline placement only when upstream stops throwing past the
forward or redelivery works · **Last-verified upstream SHA:** `b63d0175`.

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

### 13. A fork-local `content-ideas` automation template

**Status:** retained · **Provenance:** fork (web automation template) · **Upstream link:** none —
upstream should not receive it · **Acceptance ownership:** none — nothing enforces it, so the three
rot paths below are watch items, not gates · **Removal condition:** none while it is used; the rot
paths below are the thing to check at each sync · **Last-verified upstream SHA:** `b63d0175`.

`packages/web/src/lib/automation-templates.ts` carries a `content-ideas` template that upstream does
not have and should not receive. It surveys a week of merged pull requests and closed issues and
proposes content ideas from the decisions behind them, posted to Slack.

**Why.** The prompt hardcodes personal context: `alexlazar.dev` as the source of audience and ICP, a
fixed list of exemplar videos defining the format, and two weighting rules that only make sense for
one person's service offering. A generic version would need all of that to come from configuration,
which is more machinery than one template is worth.

Nothing here is enforced by a test, so three things rot silently. The exemplar video list goes stale
as new videos publish, and a format that drifts away from it stops being proposed. The `#content`
Slack channel is named in the prompt, so renaming the channel breaks delivery while the template
still asserts only that _some_ `#channel` was mentioned. And the prompt needs the sandbox to reach
`alexlazar.dev` and YouTube, degrading to generic output rather than failing when it cannot.

It is registered under `data-research`, which is not a clean fit. Adding a category for a single
template was judged not worth the taxonomy change.

### 14. `SessionStatusService` names its DO namespace `sessions`, not `parentSessions`

**Status:** retained (name only) · **Provenance:** fork · **Upstream link:** none · **Acceptance
ownership:** typecheck + the archive-cascade test · **Removal condition:** the rename is a name;
re-site it to upstream's if a future sync needs the namespace for something else — expect a conflict
· **Last-verified upstream SHA:** `b63d0175`.

The sixth constructor parameter of `packages/control-plane/src/session/session-status-service.ts` is
`sessions` here and `parentSessions` upstream. Same binding, same position, different name.

**Why.** Upstream reaches through that namespace for exactly one thing, notifying the parent of a
child update, so `parentSessions` describes every use it has. Our archive cascade also reaches
_children_ through it: `cascadeArchiveToChildren()` resolves each child DO from the same binding. A
parameter called `parentSessions` holding the stub of a child reads as a bug at the call site.

Expect a conflict on the next sync. Upstream edits this constructor whenever it adds a dependency,
and the rename touches the same lines. Take upstream's _parameter list_ and keep our _name_.

### 15. Follow-up prompts remain usable while a session runs

**Status:** retained · **Provenance:** fork · **Upstream link:** none · **Acceptance ownership:**
control-plane websocket tests · **Removal condition:** none while the old/new version overlap window
matters · **Last-verified upstream SHA:** `b63d0175`.

An acknowledgement carrying a server-generated message ID confirms the sole pending delivery on the
requesting socket. This keeps retries safe while old and new control-plane versions overlap; the
acknowledgement is never broadcast or correlated across requesters.

**Why.** The control plane already persisted and drained pending prompts in order, but the web
client disabled delivery while processing and ignored the acknowledgement. Users had to hold
complete work in an unsubmitted textarea until the active run ended, and a disconnected send cleared
that work. The Durable Object's message table remains the only queue; the browser only renders its
snapshot.

### 16. One-shot prompts use replay-safe automation launches

**Status:** retained · **Provenance:** fork · **Upstream link:** none · **Acceptance ownership:**
control-plane tests · **Removal condition:** none while scheduling exists · **Last-verified upstream
SHA:** `b63d0175`.

The new-session composer can persist a prompt for one future execution without creating or warming a
session. The scheduler claims the task atomically, then initializes its preassigned session and
message IDs. Matching retries succeed while conflicting ID reuse fails.

**Why.** A scheduler response can be lost after the session or prompt was persisted. Fresh IDs on
retry created duplicate work, while allocating a sandbox during composition defeated scheduling's
main promise that nothing runs before the due time.

### 17. Prompt composers accept draft-only voice input

**Status:** retained · **Provenance:** fork · **Upstream link:** none · **Acceptance ownership:**
web tests · **Removal condition:** none while the vocabulary-steering path is used · **Last-verified
upstream SHA:** `b63d0175`.

Both prompt composers can record one browser-native audio clip and send it to an authenticated web
route for OpenAI transcription. The transcript is appended to the editable draft and never submits
itself. Session creation, prompt delivery, persistence, and sandbox protocols remain unchanged.

**Why.** Coding prompts often contain enough paths, symbols, and commands that device dictation is
unreliable. Server-side transcription allows vocabulary steering without exposing the OpenAI key to
the browser, while keeping mistakes visible and editable before they can start agent work.

### 18. The terminal toggle keeps its functional state updater

**Status:** retained · **Provenance:** fork (declined hunk of upstream `0273a0e5`) · **Upstream
link:** upstream `0273a0e5` · **Acceptance ownership:** none — the race needs two clicks in one
render pass, so nothing covers it; the risk is a re-proposal that goes green · **Removal
condition:** none — upstream's version reintroduces a stale read; keep ours until upstream fixes the
underlying race · **Last-verified upstream SHA:** `b63d0175`.

`packages/web/src/app/(app)/session/[id]/page.tsx` toggles the terminal panel with
`setTerminalOpen((prev) => ...)`. Upstream `0273a0e5` rewrote it to read `terminalOpen` from the
closure and added the value to the callback's dependency list. We declined that hunk and took the
rest of the commit.

**Why.** The rewrite was made to satisfy a lint rule. It reintroduces the stale read the functional
form exists to avoid. Two toggles in one tick both see the same `terminalOpen`, so the second toggle
is lost and both the panel and the `terminal-visible` localStorage key remain open instead of
returning to closed. Nothing in the suite covers it because the race needs two clicks inside one
render pass.

Re-proposing it is the specific risk. Upstream's version is the one a wholesale take of this file
brings back, and it goes green.

### 19. Linear GraphQL responses are validated without the upstream callback rewrite

**Status:** retained · **Provenance:** fork (`55aba67`) · **Upstream link:** none — upstream's
validation arrived with a later auth rewrite we did not take · **Acceptance ownership:**
`packages/linear-bot` response-schema tests · **Removal condition:** adopt upstream's client whole
only if it preserves the issue-start transition; it does not yet · **Last-verified upstream SHA:**
`b63d0175`.

`packages/linear-bot/src/utils/linear-client.ts` parses each touched operation through an explicit
Zod schema from `packages/linear-bot/src/types.ts`. The issue-start transition keeps its fork-local
state handling while validating its own query and mutation responses.

**Why.** Upstream's response validation arrived with a later authentication and callback rewrite.
This fork needs the boundary checks without changing its existing webhook and issue-start behavior,
so future syncs must port Linear client changes selectively rather than replace the package.

### 20. Child session trees default to collapsed in the sidebar

**Status:** retained · **Provenance:** fork `0b12c30` (stabilize session tree pagination) ·
**Upstream link:** none · **Acceptance ownership:**
`packages/web/src/components/session-sidebar.test.tsx` and the control-plane D1 integration tests ·
**Removal condition:** none while fan-out can create enough child rows to make the sidebar unusable
· **Last-verified upstream SHA:** `b63d0175`.

`packages/web/src/components/session-sidebar.tsx` hides a parent's full descendant tree until its
disclosure control is opened. The control reports the descendant count and active-child signal, and
matching descendants open again whenever the search query changes. Its dedicated tree-list mode
keyset-paginates base sessions while returning their complete ancestor closure; flat consumers keep
offset pagination. Migration `9008_session_tree_pagination_indexes.sql` supports the composite
cursor order. The collapse, activity roll-up, pagination, and search-reset behavior is pinned by
`packages/web/src/components/session-sidebar.test.tsx` and the control-plane D1 integration tests.

**Why.** Agent fan-out can create enough child rows to make the sidebar hard to scan. Keeping the
tree collapsed preserves parent-focused navigation while still surfacing active work and search
matches that would otherwise be hidden. Preserving ancestor closure prevents a recent child from
appearing as a standalone root until pagination happens to load its older parent.

### 21. Session unread state is per user and message-scoped

**Status:** retained · **Provenance:** fork `917ef9f` (per-user unread session state) · **Upstream
link:** none · **Acceptance ownership:** web unread-state tests · **Removal condition:** none while
multi-participant review of background sessions exists · **Last-verified upstream SHA:** `b63d0175`.

Completed and failed turns project their latest message id into the D1 session index. A separate
per-user read cursor drives the sidebar's unread dot, manual read/unread actions, and
child-to-parent visual rollup. Viewing the latest output clears automatic unread state but never
clears a manual unread marker. External completion notifications do not change this state.

**Why.** Several background sessions can finish while the user is elsewhere. Session status cannot
represent whether one participant has reviewed the latest response, and a global read flag would let
one participant clear another's inbox. Future syncs must preserve the completion projection in both
normal and synthetic failure paths, the `9005_session_read_states.sql` migration, and the sidebar's
desktop and mobile actions.

### 22. Daily upstream exchange scans have a durable commit ledger

**Status:** retained · **Provenance:** fork `22b00e7` (daily upstream exchange automations) and the
control-plane `UpstreamExchangeStore` · **Upstream link:** none — report-only by design ·
**Acceptance ownership:** control-plane `UpstreamExchangeStore` tests · **Removal condition:** once
a whole-upstream sync replaces the need for read-only per-commit classification (#267) ·
**Last-verified upstream SHA:** `b63d0175`.

`terraform/d1/migrations/9007_upstream_exchange_ledger.sql`, the control-plane
`UpstreamExchangeStore`, and the sandbox's `upstream-exchange` tool persist one immutable
classification per source commit. The two fork-specific templates in
`packages/web/src/lib/automation-templates.ts` scan both directions and post read-only reports to
Slack. A successful automation callback advances a scan only when every expected commit has a
classification and `slack-notify` recorded a delivery receipt.

**Why.** A cron slot, automation invocation, and Slack post do not say which commits were examined.
Using any of them as the cursor loses commits after a failed run or classifies the same work again.
The finalized `to_sha` is the cursor, while classifications from failed scans remain reusable. The
inbound boundary is deliberately report-only: it never creates local artifacts or merges. The
outbound boundary never writes upstream.

### 23. Restored sessions preserve workspace state

**Status:** retained · **Provenance:** fork `569af58` (preserve workspace state across resumes) +
`8fe85fa` (restore OpenCode readiness on Daytona resume) · **Upstream link:** none · **Acceptance
ownership:** the real-Git resume cases in
`packages/sandbox-runtime/tests/test_entrypoint_build_mode.py` · **Removal condition:** none while
the filesystem is the session's working state · **Last-verified upstream SHA:** `b63d0175`.

Snapshot restores and persistent Daytona resumes fetch each repository's remote tracking ref without
checking it out. Local commits, dirty tracked files, and untracked files remain unchanged. A missing
upstream branch records a warning and does not prevent the session from starting. Fresh boots,
builds, and repo-image starts still synchronize their checkout to the requested remote branch.

The real-Git resume cases in `packages/sandbox-runtime/tests/test_entrypoint_build_mode.py` pin the
workspace behavior for both restore paths. A partial checkout without a persisted OpenCode session
remains a fresh boot and still runs setup.

**Why.** The filesystem is the session's working state. Publishing a commit is a separate action and
must not decide whether work survives an inactivity stop, provider restart, or snapshot restore.
Fetching preserves visibility into remote movement without choosing a merge policy or discarding
either side.

### 24. Finished child results are delivered to the parent agent

**Status:** retained · **Provenance:** fork `707f756` (deliver finished child results), `3361bd8`
(edge-trigger child delivery), and `1a7aeda` (request the final response through the supported
summary contract), issues [#285](https://github.com/mauricedesaxe/background-agents/issues/285) and
[#289](https://github.com/mauricedesaxe/background-agents/issues/289) · **Upstream link:** none ·
**Acceptance ownership:** `packages/control-plane/src/session/child-result-prompt.test.ts`, the
parent prompt case in `packages/control-plane/test/integration/child-session-ops.test.ts`, and the
`delivers child results only on status-transition notifies for terminal statuses` case in
`packages/control-plane/src/session/http/handlers/child-sessions.handler.test.ts` · **Removal
condition:** adopt upstream only when it wakes the parent agent with the finished child's result; it
does not yet · **Last-verified upstream SHA:** `b63d0175`.

When a child session goes terminal, the parent now fetches the child's summary (final response plus
PR artifacts), enqueues an agent-sourced prompt with that result, and lets the existing message
queue resume the sandbox and dispatch it. Archived and cancelled parents are left alone. Delivery is
edge-triggered: only a child _status transition_ to a terminal state enqueues the result, so a title
update after a child finishes does not re-enqueue a duplicate parent prompt. Activity records
through the one shared choke point after the non-activity early outs.

**Why.** A child's finished summary sat unused while its parent's sandbox could already be stopped,
so the user had to prompt by hand. Delivering the outcome to the parent agent keeps fan-out
self-driving.

### 25. Provider failure and stalls surface instead of reading as "thinking"

**Status:** retained · **Provenance:** fork `e7bbf0d` (stop retrying a provider usage limit),
`647303c` (surface a provider retry), `bfac2fc` (fail a prompt that stops making progress), and
`074e988` (exclude retry statuses from progress), issues
[#278](https://github.com/mauricedesaxe/background-agents/issues/278) and
[#279](https://github.com/mauricedesaxe/background-agents/issues/279) · **Upstream link:** none —
upstream's retry is silently infinite · **Acceptance ownership:** the provider-failure and
session-progress cases in `packages/sandbox-runtime/tests/test_bridge_sse.py` · **Removal
condition:** adopt upstream only when it bounds a provider retry and fails a stalled prompt; it does
not yet (`b28cfa7`) · **Last-verified upstream SHA:** `b28cfa7`.

A provider usage-limit `429` sits in the SDK's retry set, so it was retried behind OpenCode's back:
the assistant message stayed empty, no error was recorded, and the prompt ran to its 90-minute
ceiling before the control plane killed it with a generic timeout. The plugin now recognizes that
one body and hands back a status the SDK reports rather than retries, putting the provider's own
words (plan and reset time included) onto OpenCode's error path, which the bridge forwards to the
UI. Every other rejection passes through untouched, since the SDK's retry is how a transient
upstream failure gets absorbed.

OpenCode still retries a rejected provider request on a schedule with no attempt cap, so the bridge
forwards OpenCode's own published retry status (attempt number, next attempt time, normalized
provider message) as a `provider_retry` event. That covers every provider without parsing any
vendor's error body, and it makes the stall visible rather than read as a thinking session.

A second, separate deadline asks whether the agent is working, not just whether the socket is alive.
OpenCode heartbeats every 30 seconds, so a session that produced nothing could previously hold the
stream open to the ceiling. Message events and session events other than `busy` and `retry` status
reports answer the session-progress deadline, because those reports describe a wait rather than
forward progress. OpenCode multiplexes file, lsp, and storage chatter onto the same stream, so those
events do not count either. Ten minutes rather than five, so a legitimate context compaction,
bounded at five minutes, cannot trip it.

**Why.** Three sessions lost roughly four hours each to a usage-limit stall on 2026-08-05 with no
signal anywhere. A provider-rejection stall and a session that stopped producing are both invisible
until they fail; surfacing them is what makes the difference between a recoverable prompt and a
silent 90 minutes.

### 26. The sandbox-runtime node test suites run in CI

**Status:** retained · **Provenance:** fork `49b3978` · **Upstream link:** none · **Acceptance
ownership:** the `test-js-sandbox-runtime` CI job itself · **Removal condition:** none — it is the
acceptance harness for the JS-side seams above · **Last-verified upstream SHA:** `b63d0175`.

The sandbox-runtime package ships JavaScript (OpenCode plugins, in-sandbox agent tools) alongside
Python, and its `node:test` files had no runner in CI, so they passed by never executing. A bare
directory is resolved as a module rather than expanded, so the glob in the new
`test-js-sandbox-runtime` job (`node --test "tests/*.test.mjs"`) is load-bearing.

**Why.** A test that never runs is not a test. This closes the acceptance gap for the bridge and
plugin seams on this record that are written in `*.test.mjs`.

## Where we match upstream against our own docs

The list above is where we differ from upstream. This is the inverse: a place where matching
upstream puts us at odds with a document in this repo, and matching upstream still wins.

**The sandbox clone identity lives in `packages/control-plane/src/sandbox/sandbox-env.ts`, not under
`source-control/`.** `scmCloneIdentity` maps an SCM provider to the `VCS_HOST` and
`VCS_CLONE_USERNAME` the in-sandbox credential helper uses, plus the hosts its clone-token secret
may be released to. [ADR 0001](adr/0001-single-provider-scm-boundaries.md) says sandbox
credential-helper auth belongs in provider implementations, and the
[provider contribution checklist](provider-contribution-checklist.md) says no provider-specific
token logic outside provider/auth modules. Read literally, both point away from where this sits.

**Why it stays.** Upstream ships that ADR and puts the identity in `sandbox-env.ts` anyway. Moving
it would put us deliberately out of step in a file upstream actively edits, which costs the next
sync the exact thing the posture above buys. The ADR is upstream's to reconcile with its own code.

**What it costs, and what to watch.** Authentication policy now has two owners: this map hardcodes
`x-access-token`, and `source-control/providers/github-provider.ts` independently returns the same
string as the credential broker's username. Nothing fails if they drift, and a drift means the
sandbox authenticates as one identity while the broker vends another. If a third caller appears, or
if either side gains a provider the other lacks, that is the point to collapse them onto one owner
rather than add to the duplication.

Expect a reviewer to flag the placement; upstream's `#1059` (`ef820591`) is the commit that would
re-site it, and taking that is the moment to revisit this note rather than before.

## Watch items: renames and behaviours to adopt, not fight

These are not divergences. They are upstream changes a sync should pick up wholesale, noted here so
a sync does not read them as conflicts.

**Upstream renamed the fan-out scripts from `task` to `child`.** This is a rename to adopt, not a
conflict. When syncing, take upstream's `child` naming and let the rename land; do not keep a
`task`-named copy alive to "avoid churn". Confirm the rename covers the script files and any
references across `packages/` before closing the sync. (Source: #263's probe evidence, 2026-08-07.)

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

| Package              | What diverges                                                                         |
| -------------------- | ------------------------------------------------------------------------------------- |
| `control-plane`      | Nearly all of our behaviour. By far the heaviest package.                             |
| `sandbox-runtime`    | Bridge recovery/reattachment, provider-failure surfacing, harness install, whiteboard |
| `web`                | Board UI, compaction status, sidebar, settings, automations                           |
| `shared`             | Models, artifacts, compaction event, Slack `truncated`                                |
| `github-bot`         | Review prompt sources `lazar-review`; forward decoupling                              |
| `daytona-infra`      | Toolchain: jj, sandbox version                                                        |
| `modal-infra`        | The harness install call in the image build, nothing else                             |
| `opencomputer-infra` | The harness install call in the image build, nothing else                             |
| `slack-bot`          | Page-cap warning, and a Terraform binding parity guard                                |
| `linear-bot`         | GraphQL response validation; fork-local start transitions                             |

Recompute the counts rather than remembering them, since any commit changes them:

```sh
git diff --name-only "$(git merge-base HEAD upstream/main)"..HEAD | grep '^packages/'
```

`linear-bot` cannot be taken whole. Port upstream client changes around the operation-specific
response schemas and preserve the existing issue-start transition and webhook behavior.

`slack-bot` was in the same position one issue earlier. A sync was written to take both bots
wholesale on the strength of a row like the one above, and by the time it ran a fan-out fix had
landed in `slack-bot`, so the take would have dropped it silently. **Prove divergence per package at
the moment you sync, rather than trusting this table**, which records the last sync and not today.

The behaviour that diverges is documented on `fetchThreadHistory` in
`packages/slack-bot/src/events/message-handler.ts` and pinned by
`warns when the thread came back truncated` in `packages/slack-bot/src/index.test.ts`. It **spans
two packages**, which is the part a sync gets wrong: the flag is produced by `getThreadMessages` in
`packages/shared/src/slack/client.ts` and consumed in `slack-bot`, so taking upstream's version of
_either_ file drops it, and taking the `shared` one breaks the warning from underneath rather than
at the call site. **Upstream has no such signal and its own doc comment asserts the opposite**,
claiming the newest messages survive the page cap; they do not, because pagination runs
oldest-first. That is why this one survives a sync only if someone reads this entry: upstream's
version is not a conflict and not a red test, just a quieter bot.

The neighbouring behaviour, bounding author resolution to the ten retained messages, **is no longer
a divergence**. Upstream has since fixed it the same way, so this fork now matches.
`resolves author names only for the thread messages it keeps` stays as a regression guard, because
nothing upstream pins it.

### The binding parity guard

`packages/slack-bot/src/types/env-terraform-parity.test.ts` and the `tsconfig.test.json` that lets
it use Node APIs are fork-local, and they exist because of a whole class of loss this document
otherwise misses. A Worker binding is declared in two places that no check compares: the `Env`
interface and the Terraform. `SLACK_COMPLETION_QUEUE` shipped in upstream's code with no
corresponding queue in ours, because a convergence took `packages/` and left `terraform/` behind.
Nothing caught it — TypeScript believes `Env`, tests inject their own env, and a plan cannot diff a
binding that was never declared, so the first symptom would have been every Slack completion
callback returning 503 in production.

**A convergence scoped to `packages/` is incomplete.** Upstream ships infrastructure alongside code,
so check `terraform/` for the same commit range whenever a package moves.

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

**Fork-only files stay under `packages/`.** There are three deliberate exceptions outside it, and
each earns it the same way: upstream will never have the file, so it can never conflict during a
sync.

- **This document.** The divergence analysis has been produced and lost twice, so it is committed.
- **`.claude/agents/`.** Repo-local reviewer agents, auto-discovered by `lazar-review` locally and
  by the PR review bot. `fork-divergence-reviewer.md` is the one that keeps this document honest by
  checking its claims against the tree on every PR that touches them.
- **`terraform/d1/migrations/9xxx_*.sql`.** Fork-local D1 schema changes use the reserved 9000+
  range so upstream can keep allocating lower migration identifiers without silently shadowing ours.
  These files sit beside the migration runner that deploys them.

General harness configuration is still not committed here, and the exception above is narrow: a
reviewer that encodes _this repo's_ invariants has nowhere else to live, because a global agent
cannot know them. Tracker configuration and per-repo conventions stay in a machine-local note
outside the repo. A file upstream does not have can never conflict, but it is still a file every
future sync has to reason about, so the count stays low on purpose.
