from pathlib import Path

import pytest

from sandbox_runtime.checkpoint import (
    CheckpointError,
    build_checkpoint_request,
    run_checkpoint,
)
from sandbox_runtime.repo_config import RepoEntry


def repository(path: Path, *, base_sha: str | None = None) -> RepoEntry:
    path.mkdir()
    return RepoEntry(
        owner="acme/platform",
        name="api",
        branch="main",
        path=path,
        base_sha=base_sha or "a" * 40,
    )


def executable(tmp_path: Path, body: str) -> str:
    path = tmp_path / "lazar-checkpoint"
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o755)
    return str(path)


def test_builds_strict_identity_bound_request(tmp_path):
    repo = repository(tmp_path / "api", base_sha="A" * 40)

    request = build_checkpoint_request(
        checkpoint_id="session-1.message-2",
        vcs_host="github.com",
        repositories=[repo],
    )

    assert request == {
        "schemaVersion": 1,
        "checkpointId": "session-1.message-2",
        "repositories": [
            {
                "identity": {"host": "github.com", "owner": "acme/platform", "name": "api"},
                "path": str(repo.path.resolve()),
                "remote": {"type": "identity", "name": "origin"},
                "baseOid": "a" * 40,
                "lease": {"type": "expectedAbsent"},
            }
        ],
        "beads": {"type": "off"},
    }


@pytest.mark.parametrize("checkpoint_id", ["", "contains/slash", "contains space"])
def test_rejects_unsafe_checkpoint_ids(tmp_path, checkpoint_id):
    with pytest.raises(CheckpointError, match="unsafe"):
        build_checkpoint_request(
            checkpoint_id=checkpoint_id,
            vcs_host="github.com",
            repositories=[repository(tmp_path / "api")],
        )


def test_requires_the_boot_time_base_commit(tmp_path):
    repo = repository(tmp_path / "api")
    repo = RepoEntry(repo.owner, repo.name, repo.branch, repo.path)

    with pytest.raises(CheckpointError, match="base is unavailable"):
        build_checkpoint_request(
            checkpoint_id="session.message",
            vcs_host="github.com",
            repositories=[repo],
        )


@pytest.mark.asyncio
async def test_returns_a_durable_receipt(tmp_path):
    request = {"schemaVersion": 1, "repositories": [{}]}
    binary = executable(
        tmp_path,
        "read request\n"
        'printf \'%s\\n\' \'{"schemaVersion":1,"status":"durable",'
        '"repositories":[{"outcome":{"status":"unchanged"}}],'
        '"beads":{"status":"off"}}\'',
    )

    receipt = await run_checkpoint(request, executable=binary)

    assert receipt["status"] == "durable"


@pytest.mark.asyncio
async def test_preserves_a_blocked_receipt_without_child_diagnostics(tmp_path):
    binary = executable(
        tmp_path,
        "read request\n"
        "printf '%s\\n' 'child secret' >&2\n"
        'printf \'%s\\n\' \'{"schemaVersion":1,"status":"blocked",'
        '"repositories":[],"beads":{"status":"off"}}\'\n'
        "exit 2",
    )

    with pytest.raises(CheckpointError, match="durable") as raised:
        await run_checkpoint({"schemaVersion": 1}, executable=binary)

    assert raised.value.receipt is not None
    assert raised.value.receipt["status"] == "blocked"
    assert "child secret" not in str(raised.value)


@pytest.mark.asyncio
async def test_rejects_success_without_a_durable_receipt(tmp_path):
    binary = executable(tmp_path, "read request\nprintf '%s\\n' 'not json'")

    with pytest.raises(CheckpointError, match="invalid receipt"):
        await run_checkpoint({"schemaVersion": 1}, executable=binary)


@pytest.mark.asyncio
async def test_rejects_a_durable_status_without_repository_receipts(tmp_path):
    binary = executable(
        tmp_path,
        "read request\n"
        'printf \'%s\\n\' \'{"schemaVersion":1,"status":"durable",'
        '"repositories":[],"beads":{"status":"off"}}\'',
    )

    with pytest.raises(CheckpointError, match="incomplete repository"):
        await run_checkpoint(
            {"schemaVersion": 1, "repositories": [{}]},
            executable=binary,
        )
