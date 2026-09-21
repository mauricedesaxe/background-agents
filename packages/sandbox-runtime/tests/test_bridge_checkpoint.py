import asyncio
import contextlib
from pathlib import Path
from unittest.mock import ANY, AsyncMock, MagicMock

import pytest

from sandbox_runtime.bridge import CHECKPOINT_FAILURE_MESSAGE, AgentBridge
from sandbox_runtime.checkpoint import BeadsBaseline, CheckpointError
from sandbox_runtime.repo_config import RepoEntry
from sandbox_runtime.types import SessionConfig
from tests.conftest import ScriptedHarness


def durable_receipt(*, beads: dict[str, str] | None = None) -> dict:
    return {
        "schemaVersion": 1,
        "status": "durable",
        "repositories": [
            {
                "identity": {"host": "github.com", "owner": "acme", "name": "app"},
                "outcome": {"status": "unchanged"},
            }
        ],
        "beads": beads or {"status": "off"},
    }


def checkpoint_bridge(
    tmp_path: Path,
    harness: ScriptedHarness,
    *,
    authority: str = "off",
) -> AgentBridge:
    repo_path = tmp_path / "app"
    repo_path.mkdir()
    bridge = AgentBridge(
        sandbox_id="sandbox-1",
        session_id="session-1",
        control_plane_url="https://control.example.com",
        auth_token="token",
        harness=harness,
        session_config=SessionConfig(session_id="session-1", beads_authority=authority),
        vcs_host="github.com",
    )
    bridge.repositories = [
        RepoEntry(
            owner="acme",
            name="app",
            branch="main",
            path=repo_path,
            base_sha="a" * 40,
        )
    ]
    bridge._configure_git_identity = AsyncMock()
    bridge.diff_refresh.request = MagicMock()
    return bridge


def prompt(message_id: str) -> dict:
    return {
        "type": "prompt",
        "messageId": message_id,
        "content": "work",
        "author": {"gitIdentity": {"mode": "agent-only"}},
    }


async def output_stream(message_id: str, text: str):
    yield {"type": "token", "messageId": message_id, "content": text}


@pytest.mark.asyncio
async def test_checkpoint_finishes_before_completion_and_receipt_is_included(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bridge = checkpoint_bridge(tmp_path, ScriptedHarness(output_stream))
    receipt = durable_receipt()
    order: list[str] = []

    async def checkpoint(request: dict) -> dict:
        assert request["checkpointId"] == "session-1.message-1"
        order.append("checkpoint")
        return receipt

    async def send(event: dict) -> None:
        if event["type"] == "execution_complete":
            order.append("execution_complete")
            assert event["checkpointReceipt"] == receipt

    monkeypatch.setattr("sandbox_runtime.bridge.run_checkpoint", checkpoint)
    bridge._send_event = send

    await bridge._handle_prompt(prompt("message-1"))

    assert order == ["checkpoint", "execution_complete"]


@pytest.mark.asyncio
async def test_writer_receipt_advances_the_next_turn_baseline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bridge = checkpoint_bridge(tmp_path, ScriptedHarness(output_stream), authority="writer")
    bridge.beads_baseline = BeadsBaseline(bridge.repositories[0].path.resolve(), "main", "first123")
    requests: list[dict] = []

    async def checkpoint(request: dict) -> dict:
        requests.append(request)
        commit = "second456" if len(requests) == 1 else "third789"
        return durable_receipt(
            beads={
                "status": "writerPushed",
                "observedBranch": "main",
                "observedCommit": commit,
            }
        )

    monkeypatch.setattr("sandbox_runtime.bridge.run_checkpoint", checkpoint)
    bridge._send_event = AsyncMock()

    await bridge._handle_prompt(prompt("message-1"))
    await bridge._handle_prompt(prompt("message-2"))

    assert requests[0]["beads"]["expectedCommit"] == "first123"
    assert requests[1]["beads"]["expectedCommit"] == "second456"
    assert bridge.beads_baseline == BeadsBaseline(
        bridge.repositories[0].path.resolve(), "main", "third789"
    )


@pytest.mark.asyncio
async def test_checkpoint_failure_emits_only_safe_error_and_refreshes_diff(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bridge = checkpoint_bridge(tmp_path, ScriptedHarness(output_stream))
    sent: list[dict] = []
    bridge._send_event = AsyncMock(side_effect=lambda event: sent.append(event))
    monkeypatch.setattr(
        "sandbox_runtime.bridge.run_checkpoint",
        AsyncMock(
            side_effect=CheckpointError(
                "checkpoint blocked",
                {"status": "blocked", "diagnostic": "child-secret"},
            )
        ),
    )

    await bridge._handle_command(prompt("message-1"))
    task = bridge._current_prompt_task
    assert task is not None
    with contextlib.suppress(CheckpointError):
        await task
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert [event for event in sent if event["type"] == "execution_complete"] == []
    assert [event for event in sent if event["type"] == "error"] == [
        {
            "type": "error",
            "messageId": "message-1",
            "error": CHECKPOINT_FAILURE_MESSAGE,
        }
    ]
    assert "child-secret" not in str(sent)
    bridge.diff_refresh.request.assert_called_with("message-1")


@pytest.mark.asyncio
async def test_caught_harness_cancellation_still_checkpoints(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class CancelledHarness(ScriptedHarness):
        async def run_prompt(self, prompt, emit):
            raise asyncio.CancelledError

    bridge = checkpoint_bridge(tmp_path, CancelledHarness())
    checkpoint = AsyncMock(return_value=durable_receipt())
    monkeypatch.setattr("sandbox_runtime.bridge.run_checkpoint", checkpoint)
    bridge._send_event = AsyncMock()

    await bridge._handle_prompt(prompt("message-1"))

    checkpoint.assert_awaited_once()
    bridge._send_event.assert_awaited_once_with(
        {
            "type": "execution_complete",
            "messageId": "message-1",
            "success": False,
            "error": "Task was cancelled",
            "checkpointReceipt": durable_receipt(),
        }
    )


@pytest.mark.asyncio
async def test_stop_does_not_cancel_an_active_checkpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bridge = checkpoint_bridge(tmp_path, ScriptedHarness(output_stream))
    started = asyncio.Event()
    release = asyncio.Event()

    async def checkpoint(request: dict) -> dict:
        started.set()
        await release.wait()
        return durable_receipt()

    monkeypatch.setattr("sandbox_runtime.bridge.run_checkpoint", checkpoint)
    bridge._send_event = AsyncMock()
    task = asyncio.create_task(bridge._handle_prompt(prompt("message-1")))
    bridge._current_prompt_task = task
    await started.wait()

    await bridge._handle_stop()

    assert task.cancelled() is False
    assert task.done() is False
    release.set()
    await task
    bridge._send_event.assert_awaited_with(
        {
            "type": "execution_complete",
            "messageId": "message-1",
            "success": True,
            "checkpointReceipt": durable_receipt(),
        }
    )


@pytest.mark.asyncio
async def test_baseline_is_captured_once_before_harness_open(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    order: list[str] = []

    class OrderedHarness(ScriptedHarness):
        async def open(self) -> None:
            order.append("open")

    bridge = checkpoint_bridge(tmp_path, OrderedHarness(), authority="readonly")
    baseline = BeadsBaseline(bridge.repositories[0].path.resolve(), "main", "abc123")
    monkeypatch.setattr(
        "sandbox_runtime.bridge.load_repo_manifest", MagicMock(return_value=bridge.repositories)
    )

    async def capture(repositories, authority):
        order.append("baseline")
        assert repositories == bridge.repositories
        assert authority == "readonly"
        return baseline

    monkeypatch.setattr("sandbox_runtime.bridge.capture_beads_baseline", capture)

    async def connect() -> None:
        bridge.shutdown_event.set()

    bridge._connect_and_run = connect
    bridge.git_signing.initialize = AsyncMock()
    bridge.diff_refresh.close = AsyncMock()

    await bridge.run()

    assert order == ["baseline", "open"]
    assert bridge.beads_baseline == baseline


@pytest.mark.asyncio
async def test_baseline_failure_is_a_deterministic_startup_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fatal_path = tmp_path / "fatal.txt"
    harness = ScriptedHarness()
    bridge = checkpoint_bridge(tmp_path, harness, authority="readonly")
    bridge.log = MagicMock()
    bridge.diff_refresh.close = AsyncMock()
    monkeypatch.setattr("sandbox_runtime.bridge.BRIDGE_FATAL_ERROR_FILE_PATH", str(fatal_path))
    monkeypatch.setattr(
        "sandbox_runtime.bridge.load_repo_manifest", MagicMock(return_value=bridge.repositories)
    )
    monkeypatch.setattr(
        "sandbox_runtime.bridge.capture_beads_baseline",
        AsyncMock(side_effect=CheckpointError("Beads status command failed")),
    )

    with pytest.raises(CheckpointError, match="Beads status command failed"):
        await bridge.run()

    assert harness.opened is False
    assert fatal_path.read_text() == "Beads status command failed"
    bridge.log.error.assert_any_call("bridge.checkpoint_baseline_failed", exc=ANY)


@pytest.mark.asyncio
async def test_repository_free_session_skips_checkpoint_setup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = ScriptedHarness()
    bridge = checkpoint_bridge(tmp_path, harness)
    monkeypatch.setattr("sandbox_runtime.bridge.load_repo_manifest", MagicMock(return_value=[]))
    capture = AsyncMock()
    monkeypatch.setattr("sandbox_runtime.bridge.capture_beads_baseline", capture)

    async def connect() -> None:
        bridge.shutdown_event.set()

    bridge._connect_and_run = connect
    bridge.git_signing.initialize = AsyncMock()
    bridge.diff_refresh.close = AsyncMock()

    await bridge.run()

    capture.assert_not_awaited()
    assert bridge.beads_authority is None
    assert harness.opened is True
