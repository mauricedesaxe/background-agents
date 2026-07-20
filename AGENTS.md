# AGENTS.md

Open-Inspect is a background coding agent system that spawns sandboxed dev environments to work on
GitHub repositories. Single-tenant design. Stack: Cloudflare Workers (TypeScript), Python sandbox
providers, Next.js (React), Terraform.

This repo is a **tracked fork** of `ColeMurray/background-agents`. Before syncing with upstream, or
before changing anything that looks like it came from upstream, read [docs/FORK.md](docs/FORK.md).
It records what diverges on purpose, the reserved migration range, and why test files are merged by
hand rather than replaced.

## Architecture

Three tiers connected by WebSockets:

1. **Web Client** (Next.js on Vercel or Cloudflare Workers via OpenNext) — UI with GitHub OAuth,
   session dashboard, real-time streaming
2. **Control Plane** (Cloudflare Workers + Durable Objects) — session lifecycle, WebSocket hub,
   GitHub/auth integration. Each session is a Durable Object with SQLite storage. Uses D1 for the
   session index, repo metadata, environments, and encrypted secrets.
3. **Data Plane** (Python) — sandboxed environments running coding agents. Manages sandbox creation,
   snapshots, and repository/environment image builds. Several providers ship (`daytona-infra`,
   `modal-infra`, `opencomputer-infra`, Vercel); **this deployment runs Daytona**, and it is the
   only one carrying fork-local work beyond the shared harness install.

**Bot integrations** — all Cloudflare Workers using Hono:

- `slack-bot` — Slack messages → coding sessions
- `github-bot` — PR review assignments and @mention commands
- `linear-bot` — Linear agent webhooks → coding sessions

**Data flow**: User prompt → web client → control plane DO (WebSocket) → sandbox → streaming events
back through the same WebSocket chain.

### Package Dependency Graph

```
@open-inspect/shared  ←  control-plane, web, slack-bot, github-bot, linear-bot
```

**Build `@open-inspect/shared` first** whenever you change shared types. Other packages import from
it at build time.

## Package Overview

| Package              | Lang / Framework                   | Purpose                                                     |
| -------------------- | ---------------------------------- | ----------------------------------------------------------- |
| `shared`             | TypeScript                         | Shared types, auth utilities, model definitions             |
| `control-plane`      | TypeScript / CF Workers + DO       | Session management, WebSocket streaming, GitHub integration |
| `web`                | TypeScript / Next.js 16 + React 19 | User-facing dashboard, OAuth, real-time UI                  |
| `slack-bot`          | TypeScript / CF Workers + Hono     | Slack event handler, session creation                       |
| `github-bot`         | TypeScript / CF Workers + Hono     | PR review and @mention webhook handler                      |
| `linear-bot`         | TypeScript / CF Workers + Hono     | Linear agent webhook handler                                |
| `sandbox-runtime`    | Python 3.12 + Node                 | In-sandbox agent bridge, skills, harness install            |
| `daytona-infra`      | Python 3.12 / Daytona              | **The provider this deployment runs.** Image + lifecycle    |
| `modal-infra`        | Python 3.12 / Modal + FastAPI      | Modal provider: sandbox lifecycle and image build           |
| `opencomputer-infra` | TypeScript                         | OpenComputer provider: image build                          |

## Common Commands

```bash
# Install & build
npm install
npm run build                                    # all packages
npm run build -w @open-inspect/shared            # shared only (build first!)

# Lint & format
npm run lint:fix                                 # ESLint + Prettier fix
npm run format                                   # Prettier only
npm run typecheck                                # tsc across all TS packages

# Tests — TypeScript (Vitest)
npm test -w @open-inspect/control-plane          # unit tests (node env)
npm run test:integration -w @open-inspect/control-plane  # integration (workerd/Miniflare + real D1)
npm test -w @open-inspect/web
npm test -w @open-inspect/github-bot
npm test -w @open-inspect/slack-bot
npm test -w @open-inspect/linear-bot

# Tests — Python (pytest)
cd packages/sandbox-runtime && pytest tests/ -v      # the bridge; most fork divergence lives here
cd packages/modal-infra && pytest tests/ -v

# Python linting
cd packages/modal-infra && ruff check --fix && ruff format
```

## Testing

All TypeScript packages use **Vitest**; Python uses **pytest** + pytest-asyncio.

### Test file locations

- **control-plane unit**: co-located as `src/**/*.test.ts` — run in Node environment
- **control-plane integration**: separate `test/integration/*.test.ts` — run in workerd via
  `@cloudflare/vitest-pool-workers` with real D1 bindings
- **web, slack-bot, linear-bot**: co-located `src/**/*.test.ts`
- **github-bot**: separate `test/*.test.ts`
- **sandbox-runtime**: `tests/test_*.py` and `tests/*.test.mjs`
- **modal-infra**: `tests/test_*.py`

### Control-plane integration tests

These run inside a real `workerd` runtime with Miniflare, using the `cloudflareTest()` plugin from
`@cloudflare/vitest-pool-workers`. Important:

- Integration tests share one D1 instance — use `cleanD1Tables()` or equivalent cleanup in
  `beforeEach`/`afterEach` to avoid cross-test pollution
- D1 migrations from `terraform/d1/migrations/` are applied automatically via
  `test/integration/apply-migrations.ts`
- Helpers in `test/integration/helpers.ts`: `initSession()`, `queryDO()`, `seedEvents()`

## Coding Conventions

### Durations and timeouts

- **Use seconds for Python, milliseconds for TypeScript.** These match each ecosystem's conventions
  (Modal `timeout=` takes seconds; control-plane uses `_MS` suffixes throughout).
- **Encode the unit in the name.** Python: `timeout_seconds`. TypeScript: `timeoutMs`,
  `INACTIVITY_TIMEOUT_MS`. Never use a bare `timeout`.
- **Define each default value exactly once.** Extract to a named constant and import everywhere.
- **Don't restate literal values in comments.** Write `Defaults to DEFAULT_SANDBOX_TIMEOUT_SECONDS`,
  not `Default: 7200`.

### Extending existing patterns

- When threading an existing field through new code paths, evaluate whether the existing design
  (naming, types, units) is correct — don't blindly propagate it. Fix bad names or units in the same
  change rather than spreading the problem.

### Fork rules that bite silently

Both of these fail quietly rather than loudly, which is why they are here and not only in
[docs/FORK.md](docs/FORK.md), where the reasoning lives.

- **Fork-local session-schema migrations use identifiers from 1000 up.** Upstream owns everything
  below 1000. Migrations are applied by id and already-recorded ids are skipped with no content
  check, so reusing one upstream later claims means upstream's version silently never runs.
- **Never replace one of our test files with upstream's.** Merge test files by hand. Upstream's
  tests pass against upstream's behaviour, so a wholesale take goes green at the exact moment it
  deletes the evidence that our behaviour existed. A test that needs editing to go green after a
  port means the port dropped a behaviour.

### Commit messages

Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`. Keep the subject
under 72 characters. Use the PR body for details, not the commit message.

## Key Gotchas

- **Build order**: always build `@open-inspect/shared` before packages that depend on it.
- **PKCS#8 keys**: Cloudflare Workers require PKCS#8 format for GitHub App private keys — convert
  with `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt`.
- **Durable Object bindings**: new DO bindings require a two-phase Terraform deploy — first with
  `enable_durable_object_bindings = false`, then `true`.
- **No `wrangler.toml`**: control-plane config is generated by Terraform, not checked in.
- **Modal deployment**: never deploy `src/app.py` directly — use `modal deploy deploy.py` or
  `modal deploy -m src`. The `app.py` file doesn't import function modules.
- **Modal image rebuild**: update `CACHE_BUSTER` in `src/images/base.py` to force a rebuild.
- **Web platform choice**: set `web_platform = "cloudflare"` in Terraform variables to deploy the
  web app to Cloudflare Workers via OpenNext instead of Vercel. When using Cloudflare, Vercel
  credentials are not required (dummy defaults are used). `NEXT_PUBLIC_WS_URL` must be available at
  build time since Next.js inlines `NEXT_PUBLIC_*` vars into the client bundle.

## CI/CD

**CI runs** lint, typecheck, and tests for all TypeScript and Python packages on every push to
`main` and every PR. Actions were enabled on this fork on 2026-07-19. Before that they had never run
once, across any workflow, so a PR reporting `mergeable: MERGEABLE / state: CLEAN` meant nothing had
been checked rather than that checks had passed. Anything merged before that date was verified only
by whatever someone ran by hand.

**Deploys run.** Actions secrets were populated on 2026-07-19, `check-secrets` passes, and `apply`
has run to success several times since. Merging to `main` deploys changed services:

- **Terraform** → control plane + D1 migrations + web app if `web_platform = "cloudflare"`
  (triggers: `terraform/`, `packages/*/`)
- **Vercel** → web app when `web_platform = "vercel"` (triggers: `packages/web/`,
  `packages/shared/`)
- **Sandbox providers** → data plane (triggers: `packages/sandbox-runtime/`, `packages/*-infra/`,
  deployed via Terraform apply; Daytona is the one this deployment runs)

The `apply` job runs under `environment: production`, which has a required reviewer. So the flow is
merge, approve, then ship, and nothing reaches production unattended.

Three things that are not obvious from the workflow files:

- **Confirm the merge created a run.** A rebase-merge has been observed producing zero workflow runs
  at all, which leaves the change sitting on `main` looking deployed with nothing to approve (issue
  #75). `gh run list --branch main` after merging, and force it with
  `gh workflow run terraform.yml --ref main` if nothing appeared.
- **A healthy post-deploy plan is not empty.** `always_run = timestamp()` means every worker always
  shows as replaced. The signal to look for is that nothing says `will be created`.
- **A harness pin bump alone ships nothing on Daytona.** The harness installs at image build time,
  but Daytona's `source_hash` matches only `*.py`, `*.js`, and `*.ts`, so editing `HARNESS_REF` in
  `install-harness.sh` does not invalidate the snapshot (issue #94). `SANDBOX_VERSION` has to move
  too, and an apply has to rebuild the snapshot, before a harness change reaches a sandbox. Modal
  and Vercel filter by the same extension list and need the same treatment. OpenComputer is the
  exception: its hash covers every non-cache file under `packages/sandbox-runtime/src`, so a `.sh`
  edit invalidates it on its own and bumping `SANDBOX_VERSION` for OpenComputer is unnecessary.

## Further Reading

- [docs/FORK.md](docs/FORK.md) — what diverges from upstream on purpose, and why
- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) — deploy your own instance
- [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) — detailed architecture and session lifecycle
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution guidelines
- [packages/control-plane/README.md](packages/control-plane/README.md) — API reference, WebSocket
  protocol, D1 schema, security model
- [packages/modal-infra/README.md](packages/modal-infra/README.md) — sandbox internals, Modal
  deployment, endpoint URLs
