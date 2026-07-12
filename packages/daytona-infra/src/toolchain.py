"""Repo-local Daytona base snapshot builder."""

from __future__ import annotations

from pathlib import Path

from daytona import CreateSnapshotParams, Daytona, Image

# OpenCode version to install.
#
# Pinned to 1.14.41 — the last release before opencode's Hono → Effect Schema
# migration (landed across v1.14.42+, released 2026-05-09 onward) broke event
# publishing on the legacy `/event` SSE endpoint. With newer versions the
# bridge connects, posts the prompt, opencode processes it and records the
# assistant response in the session store, but no `message.updated` /
# `message.part.updated` / `session.idle` events are streamed back — so the
# session shows execution_complete with no reply.
#
# Symptom in bridge logs: `prompt.run outcome=success duration_ms=35-367`,
# which means `_stream_opencode_response_sse` returned with zero yielded
# events. Tracked in #567.
OPENCODE_VERSION = "1.14.41"
CODE_SERVER_VERSION = "4.109.5"
AGENT_BROWSER_VERSION = "0.21.2"
# Railway CLI — provides the `railway` binary the railway MCP (`railway mcp`)
# needs. stdio MCPs run a local binary, so it must live in the image.
RAILWAY_CLI_VERSION = "5.26.0"
# tldraw diagram export CLI (bins `tldraw` / `tldraw-cli`). Renders `.tldr`
# files to PNG via a bundled puppeteer (v25.x, Chrome-for-Testing). v6.0.1's
# puppeteer launch args are hardcoded to include `--no-sandbox` and
# `--disable-setuid-sandbox`, so it runs correctly as root with no extra
# passthrough (there is no PUPPETEER_ARGS-style env var).
TLDRAW_CLI_VERSION = "6.0.1"
# Jujutsu (jj) VCS — musl static binary from jj-vcs/jj releases; runs on this
# Debian image with no extra deps. This puts jj on PATH; wiring it into the
# git-based PR flow is a separate, non-image change.
JJ_VERSION = "0.43.0"
JJ_SHA256 = "59e5588583ac82b623239929368c65b90735931c0f26b5a16c1f04d5bb97643d"
# Bump when changing image contents to invalidate the Daytona snapshot.
# daytona-v2: install the SCM credential-helper shim and configure
# git system-wide so per-request token brokerage matches the Modal base image.
# -tldraw-jj: @kitschpatrol/tldraw-cli + verified chrome-headless-shell
# pre-warm, plus the Jujutsu binary.
SANDBOX_VERSION = "daytona-v6-review-agents"


def build_base_image(repo_root: Path) -> Image:
    """Build the Open-Inspect Daytona base image."""
    sandbox_runtime_dir = (
        repo_root / "packages" / "sandbox-runtime" / "src" / "sandbox_runtime"
    )

    return (
        Image.base("python:3.12-slim-bookworm")
        .run_commands(
            "apt-get update",
            "apt-get install -y git curl build-essential ca-certificates gnupg "
            "openssh-client jq unzip libnss3 libnspr4 libatk1.0-0 "
            "libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 "
            "libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 "
            "libpango-1.0-0 libcairo2 ffmpeg",
            "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg "
            "| dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg",
            "echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] "
            "https://cli.github.com/packages stable main' "
            "> /etc/apt/sources.list.d/github-cli.list",
            "apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*",
            "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
            "apt-get install -y nodejs",
            "npm install -g pnpm@latest",
            "curl -fsSL https://bun.sh/install | bash",
            "python -m pip install --upgrade pip",
        )
        .pip_install(
            "uv",
            "httpx",
            "websockets",
            "pydantic>=2.0",
            "PyJWT[crypto]",
        )
        .run_commands(
            f"npm install -g opencode-ai@{OPENCODE_VERSION}",
            f"npm install -g @opencode-ai/plugin@{OPENCODE_VERSION} zod",
            f"curl -fsSL -o /tmp/code-server.deb "
            f"https://github.com/coder/code-server/releases/download/v{CODE_SERVER_VERSION}/"
            f"code-server_{CODE_SERVER_VERSION}_amd64.deb",
            "dpkg -i /tmp/code-server.deb",
            "rm /tmp/code-server.deb",
            f"npm install -g agent-browser@{AGENT_BROWSER_VERSION}",
            "agent-browser install",
            f"npm install -g @railway/cli@{RAILWAY_CLI_VERSION}",
            f"npm install -g @kitschpatrol/tldraw-cli@{TLDRAW_CLI_VERSION}",
            # Add --disable-dev-shm-usage + --disable-gpu to tldraw-cli's
            # HARDCODED puppeteer launch args (it exposes no passthrough). These
            # are the standard container-Chrome flags; --disable-dev-shm-usage
            # removes the reliance on /dev/shm (only 64M here) so concurrent
            # sessions can't wedge an export. Both bundled entrypoints carry the
            # inlined args (they're backtick template literals, so the sed is
            # single-quoted to keep backticks literal). grep-guarded + `|| true`:
            # idempotent, and a miss never fails the build (the skill also wraps
            # exports in `timeout`, so this flag is preventative, not load-bearing).
            "D=$(npm root -g)/@kitschpatrol/tldraw-cli/dist; "
            "for f in \"$D/bin/cli.js\" \"$D/lib/index.js\"; do "
            "[ -f \"$f\" ] || continue; "
            "grep -q -- '--disable-dev-shm-usage' \"$f\" || "
            "sed -i 's/`--no-sandbox`,/`--no-sandbox`,`--disable-dev-shm-usage`,`--disable-gpu`,/' \"$f\"; "
            "done || true",
            # Pre-warm the chrome-headless-shell build tldraw-cli's puppeteer
            # (headless:'shell') requires. Call @puppeteer/browsers DIRECTLY:
            # the `puppeteer` bin declares devEngines>=Node24 and throws
            # EBADDEVENGINES on this Node 22 image, but @puppeteer/browsers has
            # no such field. Pin the exact build from tldraw-cli's bundled
            # puppeteer-core (not @stable, which can drift). Retry flaky Google
            # Storage downloads; non-fatal so a failed download never breaks the
            # base snapshot (tldraw just needs a reinstall then).
            "PINNED=$(node -e \"import('/usr/lib/node_modules/@kitschpatrol/tldraw-cli/node_modules/puppeteer-core/lib/puppeteer/revisions.js').then(m=>console.log(m.PUPPETEER_REVISIONS['chrome-headless-shell']))\"); "
            "n=0; until [ $n -ge 5 ]; do "
            "node /usr/lib/node_modules/@kitschpatrol/tldraw-cli/node_modules/@puppeteer/browsers/lib/main-cli.js "
            "install \"chrome-headless-shell@$PINNED\" --path \"$HOME/.cache/puppeteer\" && break; "
            "n=$((n+1)); sleep 3; done "
            "|| echo 'WARN: chrome-headless-shell pre-warm failed; tldraw export unavailable until reinstalled'",
            # Jujutsu (jj) static binary — retry download, sha256-verify, non-fatal.
            f"n=0; until [ $n -ge 5 ]; do curl -fsSL -o /tmp/jj.tar.gz https://github.com/jj-vcs/jj/releases/download/v{JJ_VERSION}/jj-v{JJ_VERSION}-x86_64-unknown-linux-musl.tar.gz && break; n=$((n+1)); sleep 3; done; "
            f"if echo '{JJ_SHA256}  /tmp/jj.tar.gz' | sha256sum -c -; then tar -xzf /tmp/jj.tar.gz -C /usr/local/bin ./jj && chmod 0755 /usr/local/bin/jj; else echo 'WARN: jj download failed or checksum mismatch; jj not installed'; fi; rm -f /tmp/jj.tar.gz",
            "mkdir -p /workspace /app /tmp/opencode",
            # Install the SCM credential-helper shim and configure git
            # system-wide. The shim delegates to the Python helper module
            # under sandbox_runtime, baked in at build time via add_local_dir
            # below. Mirror packages/modal-infra/src/images/base.py.
            "printf '%s\\n'"
            " '#!/bin/sh'"
            ' \'exec python3 -m sandbox_runtime.credentials.git_credential_helper "$@"\''
            " > /usr/local/bin/oi-git-credentials",
            "chmod 0755 /usr/local/bin/oi-git-credentials",
            "git config --system credential.helper /usr/local/bin/oi-git-credentials",
            # Pass the repo path to the helper so it can scope credentials to
            # the session repo, not just the host.
            "git config --system credential.useHttpPath true",
        )
        .env(
            {
                "HOME": "/root",
                "NODE_ENV": "development",
                "PATH": "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin",
                "PYTHONPATH": "/app",
                "NODE_PATH": "/usr/lib/node_modules",
                "SANDBOX_VERSION": SANDBOX_VERSION,
            }
        )
        .add_local_dir(str(sandbox_runtime_dir), "/app/sandbox_runtime")
        .workdir("/workspace")
    )


def create_base_snapshot(daytona: Daytona, repo_root: Path, snapshot_name: str) -> None:
    """Create the named base snapshot from the current repo contents."""
    image = build_base_image(repo_root)
    daytona.snapshot.create(
        CreateSnapshotParams(
            name=snapshot_name,
            image=image,
            entrypoint=["python", "-m", "sandbox_runtime.entrypoint"],
        ),
        on_logs=lambda chunk: print(chunk, end="\n"),
    )
