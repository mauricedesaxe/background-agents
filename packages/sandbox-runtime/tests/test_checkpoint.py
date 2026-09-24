import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.checkpoint import (
    BeadsBaseline,
    CheckpointError,
    build_checkpoint_request,
    capture_beads_baseline,
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


def beads_executable(tmp_path: Path, body: str) -> str:
    path = tmp_path / "bd"
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o755)
    return str(path)


def beads_repository(path: Path, metadata: object = None) -> RepoEntry:
    repo = repository(path)
    beads = path / ".beads"
    beads.mkdir()
    (beads / "metadata.json").write_text(
        json.dumps({"backend": "dolt"} if metadata is None else metadata)
    )
    return repo


def test_builds_strict_identity_bound_request(tmp_path):
    repo = repository(tmp_path / "api", base_sha="A" * 40)

    request = build_checkpoint_request(
        checkpoint_id="session-1.message-2",
        vcs_host="github.com",
        repositories=[repo],
        authority="off",
        baseline=None,
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


@pytest.mark.parametrize(
    "checkpoint_id",
    ["", ".", "..", ".hidden", "ends.", "branch.lock", "a..b", "contains/slash", "has space"],
)
def test_rejects_unsafe_checkpoint_ids(tmp_path, checkpoint_id):
    with pytest.raises(CheckpointError, match="unsafe"):
        build_checkpoint_request(
            checkpoint_id=checkpoint_id,
            vcs_host="github.com",
            repositories=[repository(tmp_path / "api")],
            authority="off",
            baseline=None,
        )


def test_requires_the_boot_time_base_commit(tmp_path):
    repo = repository(tmp_path / "api")
    repo = RepoEntry(repo.owner, repo.name, repo.branch, repo.path)

    with pytest.raises(CheckpointError, match="base is unavailable"):
        build_checkpoint_request(
            checkpoint_id="session.message",
            vcs_host="github.com",
            repositories=[repo],
            authority="off",
            baseline=None,
        )


@pytest.mark.asyncio
async def test_beads_off_does_not_inspect_or_execute(tmp_path):
    repo = beads_repository(tmp_path / "api")

    with patch("sandbox_runtime.checkpoint.asyncio.create_subprocess_exec") as spawn:
        baseline = await capture_beads_baseline([repo], authority="off", executable="missing-bd")

    assert baseline is None
    spawn.assert_not_called()


@pytest.mark.asyncio
async def test_no_beads_graph_returns_none_without_executing(tmp_path):
    repo = repository(tmp_path / "api")

    with patch("sandbox_runtime.checkpoint.asyncio.create_subprocess_exec") as spawn:
        baseline = await capture_beads_baseline(
            [repo], authority="readonly", executable="missing-bd"
        )

    assert baseline is None
    spawn.assert_not_called()


@pytest.mark.asyncio
async def test_captures_readonly_baseline_and_builds_request(tmp_path):
    repo = beads_repository(tmp_path / "api")
    binary = beads_executable(
        tmp_path,
        '[ "$*" = "-C '
        f'{repo.path.resolve()} --readonly vc status --json" ] || exit 9\n'
        'printf \'%s\\n\' \'{"branch":"main","commit":"abc123",'
        '"schema_version":1}\'',
    )

    baseline = await capture_beads_baseline([repo], authority="readonly", executable=binary)
    request = build_checkpoint_request(
        checkpoint_id="session-1.message-2",
        vcs_host="github.com",
        repositories=[repo],
        authority="readonly",
        baseline=baseline,
    )

    assert baseline == BeadsBaseline(repo.path.resolve(), "main", "abc123")
    assert request["beads"] == {
        "type": "readonly",
        "repositoryPath": str(repo.path.resolve()),
        "expectedBranch": "main",
        "expectedCommit": "abc123",
    }


def test_builds_writer_request_from_baseline(tmp_path):
    repo = repository(tmp_path / "api")
    baseline = BeadsBaseline(repo.path.resolve(), "main", "abc123")

    request = build_checkpoint_request(
        checkpoint_id="session-1.message-2",
        vcs_host="github.com",
        repositories=[repo],
        authority="writer",
        baseline=baseline,
    )

    assert request["beads"] == {
        "type": "writer",
        "repositoryPath": str(repo.path.resolve()),
        "expectedBranch": "main",
        "expectedCommit": "abc123",
        "commitMessage": "Open Inspect checkpoint session-1.message-2",
    }


@pytest.mark.parametrize("authority", ["readonly", "writer"])
def test_nonoff_authority_without_a_graph_builds_an_off_request(tmp_path, authority):
    repo = repository(tmp_path / "api")

    request = build_checkpoint_request(
        checkpoint_id="session-1.message-2",
        vcs_host="github.com",
        repositories=[repo],
        authority=authority,
        baseline=None,
    )

    assert request["beads"] == {"type": "off"}


@pytest.mark.parametrize("metadata", [{"backend": "sqlite"}, [], "not metadata"])
@pytest.mark.asyncio
async def test_rejects_malformed_or_non_dolt_metadata(tmp_path, metadata):
    repo = beads_repository(tmp_path / "api", metadata)

    with pytest.raises(CheckpointError, match="metadata"):
        await capture_beads_baseline([repo], authority="readonly", executable="missing-bd")


@pytest.mark.asyncio
async def test_rejects_invalid_metadata_json(tmp_path):
    repo = beads_repository(tmp_path / "api")
    (repo.path / ".beads" / "metadata.json").write_text("{")

    with pytest.raises(CheckpointError, match="metadata"):
        await capture_beads_baseline([repo], authority="readonly", executable="missing-bd")


@pytest.mark.asyncio
async def test_rejects_multiple_beads_graphs_before_executing(tmp_path):
    repositories = [
        beads_repository(tmp_path / "api"),
        beads_repository(tmp_path / "web"),
    ]

    with (
        patch("sandbox_runtime.checkpoint.asyncio.create_subprocess_exec") as spawn,
        pytest.raises(CheckpointError, match="multiple"),
    ):
        await capture_beads_baseline(repositories, authority="writer", executable="missing-bd")

    spawn.assert_not_called()


@pytest.mark.asyncio
async def test_rejects_malformed_beads_status(tmp_path):
    repo = beads_repository(tmp_path / "api")
    binary = beads_executable(
        tmp_path,
        'printf \'%s\\n\' \'{"branch":"main","commit":"abc123","schema_version":1,"extra":true}\'',
    )

    with pytest.raises(CheckpointError, match="status"):
        await capture_beads_baseline([repo], authority="readonly", executable=binary)


@pytest.mark.asyncio
async def test_beads_status_failure_does_not_leak_child_stderr(tmp_path):
    repo = beads_repository(tmp_path / "api")
    binary = beads_executable(tmp_path, "printf '%s\\n' 'child secret' >&2\nexit 2")

    with pytest.raises(CheckpointError, match="status") as raised:
        await capture_beads_baseline([repo], authority="readonly", executable=binary)

    assert "child secret" not in str(raised.value)


@pytest.mark.asyncio
async def test_beads_status_timeout_cleans_up_owned_process(tmp_path):
    repo = beads_repository(tmp_path / "api")
    process = MagicMock(returncode=None)
    process.communicate = AsyncMock(side_effect=TimeoutError)

    with (
        patch(
            "sandbox_runtime.checkpoint.asyncio.create_subprocess_exec",
            AsyncMock(return_value=process),
        ),
        patch(
            "sandbox_runtime.checkpoint.terminate_owned_subprocess", new_callable=AsyncMock
        ) as terminate,
        pytest.raises(CheckpointError, match="timed out"),
    ):
        await capture_beads_baseline(
            [repo],
            authority="readonly",
            timeout_seconds=0.01,
        )

    terminate.assert_awaited_once_with(process)


def test_rejects_off_authority_with_a_baseline(tmp_path):
    repo = repository(tmp_path / "api")

    with pytest.raises(CheckpointError, match="off"):
        build_checkpoint_request(
            checkpoint_id="session.message",
            vcs_host="github.com",
            repositories=[repo],
            authority="off",
            baseline=BeadsBaseline(repo.path.resolve(), "main", "abc123"),
        )


@pytest.mark.asyncio
async def test_returns_a_durable_receipt(tmp_path):
    request = {
        "schemaVersion": 1,
        "checkpointId": "session.message",
        "repositories": [{"identity": {"host": "github.com", "owner": "acme", "name": "api"}}],
        "beads": {"type": "off"},
    }
    binary = executable(
        tmp_path,
        "read request\n"
        'printf \'%s\\n\' \'{"schemaVersion":1,"status":"durable",'
        '"repositories":[{"identity":{"host":"github.com","owner":"acme","name":"api"},'
        '"outcome":{"status":"unchanged"}}],'
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


@pytest.mark.asyncio
async def test_rejects_a_receipt_for_a_different_repository(tmp_path):
    binary = executable(
        tmp_path,
        "read request\n"
        'printf \'%s\\n\' \'{"schemaVersion":1,"status":"durable",'
        '"repositories":[{"identity":{"host":"github.com","owner":"other","name":"api"},'
        '"outcome":{"status":"unchanged"}}],"beads":{"status":"off"}}\'',
    )

    with pytest.raises(CheckpointError, match="incomplete repository"):
        await run_checkpoint(
            {
                "schemaVersion": 1,
                "checkpointId": "session.message",
                "repositories": [
                    {"identity": {"host": "github.com", "owner": "acme", "name": "api"}}
                ],
                "beads": {"type": "off"},
            },
            executable=binary,
        )


@pytest.mark.asyncio
async def test_rejects_a_beads_receipt_for_different_authority(tmp_path):
    binary = executable(
        tmp_path,
        "read request\n"
        'printf \'%s\\n\' \'{"schemaVersion":1,"status":"durable",'
        '"repositories":[{"identity":{"host":"github.com","owner":"acme","name":"api"},'
        '"outcome":{"status":"unchanged"}}],'
        '"beads":{"status":"writerPushed","observedBranch":"main",'
        '"observedCommit":"abc123"}}\'',
    )

    with pytest.raises(CheckpointError, match="incomplete Beads"):
        await run_checkpoint(
            {
                "schemaVersion": 1,
                "checkpointId": "session.message",
                "repositories": [
                    {"identity": {"host": "github.com", "owner": "acme", "name": "api"}}
                ],
                "beads": {"type": "readonly"},
            },
            executable=binary,
        )


@pytest.mark.asyncio
async def test_rejects_malformed_durable_outcomes(tmp_path):
    binary = executable(
        tmp_path,
        "read request\n"
        'printf \'%s\\n\' \'{"schemaVersion":1,"status":"durable",'
        '"repositories":[{"identity":{"host":"github.com","owner":"acme","name":"api"},'
        '"outcome":{"status":"blocked"}}],'
        '"beads":{"status":"writerPushed","observedBranch":"main"}}\'',
    )

    with pytest.raises(CheckpointError, match="repository"):
        await run_checkpoint(
            {"schemaVersion": 1, "repositories": [{}]},
            executable=binary,
        )
