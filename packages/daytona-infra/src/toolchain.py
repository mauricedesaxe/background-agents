"""Repo-local Daytona base snapshot builder."""

from __future__ import annotations

from pathlib import Path

from daytona import CreateSnapshotParams, Daytona, Image, Resources

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
# Jujutsu (jj) VCS — musl static binary from jj-vcs/jj releases; runs on this
# Debian image with no extra deps. This puts jj on PATH; wiring it into the
# git-based PR flow is a separate, non-image change.
JJ_VERSION = "0.43.0"
JJ_SHA256 = "59e5588583ac82b623239929368c65b90735931c0f26b5a16c1f04d5bb97643d"
# Bump when changing image contents to invalidate the Daytona snapshot.
# daytona-v2: install the SCM credential-helper shim and configure
# git system-wide so per-request token brokerage matches the Modal base image.
# -tldraw-jj: (historical) added tldraw-cli + chrome-headless-shell pre-warm and
# the Jujutsu binary. tldraw-cli is now removed — diagrams are authored as JSON
# records and posted to the interactive board endpoint (see the whiteboard
# skill), so nothing renders tldraw in the sandbox.
SANDBOX_VERSION = "daytona-v14-code-style"

# Resources baked into the base snapshot. Daytona applies these to every sandbox
# created from it and rejects overriding them at create time. Memory (GiB) is the
# lever for the OOM problem; cpu (cores) is a modest bump for parallel builds.
SANDBOX_CPU_CORES = 2
SANDBOX_MEMORY_GIB = 4


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
        # Install the agent harness by running the harness's own installer, which is the same
        # script every other provider's image build calls. It runs after add_local_dir because
        # that is what puts the script on the image; HOME is set explicitly because .env() above
        # applies to the built image's runtime, not to this build step.
        .run_commands(
            "HOME=/root bash /app/sandbox_runtime/scripts/install-harness.sh --install",
        )
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
            # Daytona bakes resources into the snapshot; sandboxes created from
            # it inherit these and cannot override them at create time. ~1 GiB
            # (the provider default) OOM-kills OpenCode during heavy builds, so
            # give sandboxes real headroom. Disk is left at the provider default
            # to avoid shrinking it and to not add org disk-cap pressure (#8).
            resources=Resources(cpu=SANDBOX_CPU_CORES, memory=SANDBOX_MEMORY_GIB),
        ),
        on_logs=lambda chunk: print(chunk, end="\n"),
    )
