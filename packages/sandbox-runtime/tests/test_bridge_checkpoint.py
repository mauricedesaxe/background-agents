import asyncio
import hashlib
import json
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from sandbox_runtime.bridge import AgentBridge


def _make_bridge() -> AgentBridge:
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    bridge.opencode_session_id = "ses_checkpoint"
    bridge.http_client = AsyncMock()
    checkpoint_dir = tempfile.TemporaryDirectory()
    bridge._test_checkpoint_dir = checkpoint_dir
    bridge.checkpoint_pending_file = Path(checkpoint_dir.name) / "checkpoint-pending"
    bridge.checkpoint_terminal_events_file = Path(checkpoint_dir.name) / "checkpoint-events.json"
    return bridge


@pytest.mark.asyncio
async def test_successful_turn_uploads_checkpoint_before_completion() -> None:
    bridge = _make_bridge()
    observed: list[str] = []

    async def stream(*_args, **_kwargs):
        yield {"type": "token", "content": "done"}

    async def send(event):
        if event["type"] == "execution_complete":
            observed.append("complete")

    bridge._stream_opencode_response_sse = stream
    bridge._configure_git_identity = AsyncMock()
    bridge._export_and_upload_checkpoint = AsyncMock(
        side_effect=lambda: observed.append("checkpoint")
    )
    bridge._send_event = send

    await bridge._handle_prompt({"messageId": "msg-1", "content": "continue"})

    assert observed == ["checkpoint", "complete"]


@pytest.mark.asyncio
async def test_checkpoint_failure_does_not_turn_completed_work_into_a_retry() -> None:
    bridge = _make_bridge()
    sent: list[dict] = []

    async def stream(*_args, **_kwargs):
        yield {"type": "token", "content": "done"}

    bridge._stream_opencode_response_sse = stream
    bridge._configure_git_identity = AsyncMock()
    bridge._export_and_upload_checkpoint = AsyncMock(side_effect=RuntimeError("upload failed"))
    bridge._send_event = AsyncMock(side_effect=sent.append)

    await bridge._handle_prompt({"messageId": "msg-1", "content": "continue"})

    assert any(
        event["type"] == "checkpoint" and event["checkpointStatus"] == "failed" for event in sent
    )
    assert sent[-1] == {
        "type": "execution_complete",
        "messageId": "msg-1",
        "success": True,
    }


@pytest.mark.asyncio
async def test_failed_turn_checkpoints_tool_history_before_completion() -> None:
    bridge = _make_bridge()
    observed: list[str] = []

    async def stream(*_args, **_kwargs):
        yield {"type": "tool_call", "tool": "write", "input": {}}
        yield {"type": "error", "error": "model disconnected"}

    async def send(event):
        if event["type"] == "execution_complete":
            observed.append("complete")

    bridge._stream_opencode_response_sse = stream
    bridge._configure_git_identity = AsyncMock()
    bridge._export_and_upload_checkpoint = AsyncMock(
        side_effect=lambda: observed.append("checkpoint")
    )
    bridge._send_event = send

    await bridge._handle_prompt({"messageId": "msg-1", "content": "continue"})

    assert observed == ["checkpoint", "complete"]


@pytest.mark.asyncio
async def test_stream_failure_checkpoints_tool_history_before_completion() -> None:
    bridge = _make_bridge()
    observed: list[str] = []

    async def stream(*_args, **_kwargs):
        yield {"type": "tool_call", "tool": "write", "input": {}}
        raise RuntimeError("stream disconnected")

    async def send(event):
        if event["type"] == "execution_complete":
            observed.append("complete")

    bridge._stream_opencode_response_sse = stream
    bridge._configure_git_identity = AsyncMock()
    bridge._export_and_upload_checkpoint = AsyncMock(
        side_effect=lambda: observed.append("checkpoint")
    )
    bridge._send_event = send

    await bridge._handle_prompt({"messageId": "msg-1", "content": "continue"})

    assert observed == ["checkpoint", "complete"]


@pytest.mark.asyncio
async def test_stopped_turn_checkpoints_before_cancellation_completion() -> None:
    bridge = _make_bridge()
    observed: list[str] = []

    async def stream(*_args, **_kwargs):
        yield {"type": "tool_call", "tool": "write", "input": {}}
        await asyncio.sleep(3600)

    async def send(event):
        if event["type"] == "execution_complete":
            observed.append("complete")

    bridge._stream_opencode_response_sse = stream
    bridge._configure_git_identity = AsyncMock()
    bridge._export_and_upload_checkpoint = AsyncMock(
        side_effect=lambda: observed.append("checkpoint")
    )
    bridge._send_event = send

    await bridge._handle_command({"type": "prompt", "messageId": "msg-1", "content": "continue"})
    task = bridge._current_prompt_task
    assert task is not None
    await asyncio.sleep(0)

    await bridge._handle_stop()
    await task

    assert observed == ["checkpoint", "complete"]
    bridge.http_client.post.assert_awaited_once()


@pytest.mark.asyncio
async def test_checkpoint_upload_uses_native_export_without_replaying_messages() -> None:
    bridge = _make_bridge()
    checkpoint = json.dumps({"info": {"id": "ses_checkpoint"}, "messages": []}).encode()
    process = MagicMock(returncode=0)
    process.communicate = AsyncMock(return_value=(checkpoint, b""))
    response = MagicMock(status_code=201)
    bridge.http_client.put = AsyncMock(return_value=response)
    response.json.side_effect = lambda: {
        "status": "confirmed",
        "checkpointId": bridge.http_client.put.await_args.kwargs["headers"]["X-Checkpoint-ID"],
        "attemptId": bridge.http_client.put.await_args.kwargs["headers"]["X-Checkpoint-Attempt-ID"],
        "checksum": hashlib.sha256(checkpoint).hexdigest(),
    }

    with patch(
        "sandbox_runtime.bridge.asyncio.create_subprocess_exec",
        AsyncMock(return_value=process),
    ) as create_process:
        await bridge._export_and_upload_checkpoint()

    create_process.assert_awaited_once()
    args = create_process.await_args.args
    assert args[:3] == ("opencode", "export", "ses_checkpoint")
    assert "--pure" in args
    bridge.http_client.put.assert_awaited_once()
    request = bridge.http_client.put.await_args
    assert request.args[0].endswith("/sessions/test-session/checkpoint")
    assert request.kwargs["content"] == checkpoint
    assert request.kwargs["headers"]["Authorization"] == "Bearer test-token"
    assert request.kwargs["headers"]["X-Checkpoint-ID"].startswith("cp_")
    assert request.kwargs["headers"]["X-Checkpoint-Attempt-ID"].startswith("cpa_")
    assert request.kwargs["headers"]["X-Checkpoint-Created-At-Ms"].isdigit()


@pytest.mark.asyncio
async def test_checkpoint_upload_accepts_legacy_control_plane_confirmation() -> None:
    bridge = _make_bridge()
    checkpoint = json.dumps({"info": {"id": "ses_checkpoint"}, "messages": []}).encode()
    process = MagicMock(returncode=0)
    process.communicate = AsyncMock(return_value=(checkpoint, b""))
    response = MagicMock(status_code=201)
    response.json.return_value = {"checksum": hashlib.sha256(checkpoint).hexdigest()}
    bridge.http_client.put = AsyncMock(return_value=response)

    with patch(
        "sandbox_runtime.bridge.asyncio.create_subprocess_exec",
        AsyncMock(return_value=process),
    ):
        await bridge._export_and_upload_checkpoint()

    bridge.http_client.put.assert_awaited_once()


@pytest.mark.asyncio
async def test_checkpoint_upload_retries_with_the_same_identity_after_a_lost_response() -> None:
    bridge = _make_bridge()
    checkpoint = json.dumps({"info": {"id": "ses_checkpoint"}, "messages": []}).encode()
    process = MagicMock(returncode=0)
    process.communicate = AsyncMock(return_value=(checkpoint, b""))
    confirmed = MagicMock(status_code=200)
    bridge.http_client.put = AsyncMock(
        side_effect=[
            httpx.ReadTimeout("response lost"),
            confirmed,
        ]
    )
    confirmed.json.side_effect = lambda: {
        "status": "confirmed",
        "checkpointId": bridge.http_client.put.await_args.kwargs["headers"]["X-Checkpoint-ID"],
        "attemptId": bridge.http_client.put.await_args.kwargs["headers"]["X-Checkpoint-Attempt-ID"],
        "checksum": hashlib.sha256(checkpoint).hexdigest(),
    }

    with (
        patch(
            "sandbox_runtime.bridge.asyncio.create_subprocess_exec",
            AsyncMock(return_value=process),
        ),
        patch("sandbox_runtime.bridge.asyncio.sleep", AsyncMock()),
    ):
        await bridge._export_and_upload_checkpoint()

    assert bridge.http_client.put.await_count == 2
    first_headers = bridge.http_client.put.await_args_list[0].kwargs["headers"]
    second_headers = bridge.http_client.put.await_args_list[1].kwargs["headers"]
    assert first_headers["X-Checkpoint-ID"] == second_headers["X-Checkpoint-ID"]
    assert first_headers["X-Checkpoint-Attempt-ID"] == second_headers["X-Checkpoint-Attempt-ID"]


@pytest.mark.asyncio
async def test_checkpoint_timeout_exhaustion_reconciles_a_confirmed_upload() -> None:
    bridge = _make_bridge()
    bridge.CHECKPOINT_MAX_UPLOAD_ATTEMPTS = 2
    checkpoint = json.dumps({"info": {"id": "ses_checkpoint"}, "messages": []}).encode()
    process = MagicMock(returncode=0)
    process.communicate = AsyncMock(return_value=(checkpoint, b""))
    bridge.http_client.put = AsyncMock(side_effect=httpx.ReadTimeout("response lost"))
    restore = MagicMock(status_code=200)
    restore.json.side_effect = lambda: {
        "status": "confirmed",
        "checkpointId": bridge.http_client.put.await_args.kwargs["headers"]["X-Checkpoint-ID"],
        "attemptId": bridge.http_client.put.await_args.kwargs["headers"]["X-Checkpoint-Attempt-ID"],
        "checksum": hashlib.sha256(checkpoint).hexdigest(),
    }
    bridge.http_client.get = AsyncMock(return_value=restore)
    sent: list[dict] = []
    bridge._send_event = AsyncMock(side_effect=sent.append)

    with (
        patch(
            "sandbox_runtime.bridge.asyncio.create_subprocess_exec",
            AsyncMock(return_value=process),
        ),
        patch("sandbox_runtime.bridge.asyncio.sleep", AsyncMock()),
    ):
        await bridge._export_and_upload_checkpoint()

    assert bridge.http_client.put.await_count == 2
    bridge.http_client.get.assert_awaited_once()
    assert any(
        event["type"] == "checkpoint" and event["checkpointStatus"] == "confirmed" for event in sent
    )
    assert not bridge.checkpoint_pending_file.exists()


@pytest.mark.asyncio
async def test_checkpoint_timeout_keeps_pending_identity_when_reconciliation_is_unavailable() -> (
    None
):
    bridge = _make_bridge()
    bridge.CHECKPOINT_MAX_UPLOAD_ATTEMPTS = 1
    checkpoint = json.dumps({"info": {"id": "ses_checkpoint"}, "messages": []}).encode()
    process = MagicMock(returncode=0)
    process.communicate = AsyncMock(return_value=(checkpoint, b""))
    bridge.http_client.put = AsyncMock(side_effect=httpx.ReadTimeout("response lost"))
    bridge.http_client.get = AsyncMock(side_effect=httpx.ConnectError("control plane unavailable"))
    sent: list[dict] = []
    bridge._send_event = AsyncMock(side_effect=sent.append)

    with patch(
        "sandbox_runtime.bridge.asyncio.create_subprocess_exec",
        AsyncMock(return_value=process),
    ) as create_process:
        await bridge._save_checkpoint_or_report_failure(message_id="msg-1")
        await bridge._save_checkpoint_or_report_failure(message_id="msg-2")

    assert bridge.checkpoint_pending_file.exists()
    create_process.assert_awaited_once()
    assert any(event.get("checkpointStatus") == "in_progress" for event in sent)
    assert not any(event.get("checkpointStatus") == "failed" for event in sent)


@pytest.mark.asyncio
async def test_checkpoint_failure_retains_bounded_actionable_details() -> None:
    bridge = _make_bridge()
    bridge.CHECKPOINT_MAX_UPLOAD_ATTEMPTS = 1
    checkpoint = json.dumps({"info": {"id": "ses_checkpoint"}, "messages": []}).encode()
    process = MagicMock(returncode=0)
    process.communicate = AsyncMock(return_value=(checkpoint, b""))
    response = MagicMock(status_code=503)
    response.json.return_value = {
        "error": "x" * 2000,
        "errorClass": "pointer_put",
        "providerCode": 10001,
    }
    bridge.http_client.put = AsyncMock(return_value=response)
    sent: list[dict] = []
    bridge._send_event = AsyncMock(side_effect=sent.append)

    with patch(
        "sandbox_runtime.bridge.asyncio.create_subprocess_exec",
        AsyncMock(return_value=process),
    ):
        await bridge._save_checkpoint_or_report_failure(message_id="msg-1")

    failure = next(
        event
        for event in sent
        if event["type"] == "checkpoint" and event["checkpointStatus"] == "failed"
    )
    assert failure["checkpointStatus"] == "failed"
    assert failure["errorClass"] == "pointer_put"
    assert failure["httpStatus"] == 503
    assert failure["providerCode"] == 10001
    assert len(failure["detail"]) == 500
    assert failure["checkpointId"].startswith("cp_")
    assert failure["attemptId"].startswith("cpa_")


@pytest.mark.asyncio
async def test_checkpoint_export_failure_does_not_retain_stderr() -> None:
    bridge = _make_bridge()
    process = MagicMock(returncode=1)
    process.communicate = AsyncMock(
        return_value=(b"", b"private repository content and credential secret-token")
    )
    sent: list[dict] = []
    bridge._send_event = AsyncMock(side_effect=sent.append)

    with patch(
        "sandbox_runtime.bridge.asyncio.create_subprocess_exec",
        AsyncMock(return_value=process),
    ):
        await bridge._save_checkpoint_or_report_failure(message_id="msg-1")

    failure = next(
        event
        for event in sent
        if event["type"] == "checkpoint" and event["checkpointStatus"] == "failed"
    )
    assert failure["errorClass"] == "export_exit"
    assert failure["detail"] == "OpenCode checkpoint export exited with status 1"
    assert "private repository content" not in json.dumps(sent)
    assert "secret-token" not in json.dumps(sent)


@pytest.mark.asyncio
async def test_bridge_restart_resumes_the_pending_checkpoint_identity(tmp_path: Path) -> None:
    checkpoint = json.dumps({"info": {"id": "ses_checkpoint"}, "messages": []}).encode()
    process = MagicMock(returncode=0)
    process.communicate = AsyncMock(return_value=(checkpoint, b""))
    first = _make_bridge()
    first.checkpoint_pending_file = tmp_path / "checkpoint-pending"
    first.http_client.put = AsyncMock(side_effect=asyncio.CancelledError())

    with (
        patch(
            "sandbox_runtime.bridge.asyncio.create_subprocess_exec",
            AsyncMock(return_value=process),
        ),
        pytest.raises(asyncio.CancelledError),
    ):
        await first._export_and_upload_checkpoint()

    assert first.checkpoint_pending_file.exists()

    resumed = _make_bridge()
    resumed.checkpoint_pending_file = first.checkpoint_pending_file
    response = MagicMock(status_code=200)
    response.json.side_effect = lambda: {
        "status": "confirmed",
        "checkpointId": resumed.http_client.put.await_args.kwargs["headers"]["X-Checkpoint-ID"],
        "attemptId": resumed.http_client.put.await_args.kwargs["headers"][
            "X-Checkpoint-Attempt-ID"
        ],
        "checksum": hashlib.sha256(checkpoint).hexdigest(),
    }
    resumed.http_client.put = AsyncMock(return_value=response)
    resumed._send_event = AsyncMock()

    await resumed._resume_pending_checkpoint_or_report_failure()

    headers = resumed.http_client.put.await_args.kwargs["headers"]
    assert headers["X-Checkpoint-ID"].startswith("cp_")
    assert headers["X-Checkpoint-Attempt-ID"].startswith("cpa_")
    assert not resumed.checkpoint_pending_file.exists()


@pytest.mark.asyncio
async def test_reconnect_does_not_start_a_second_checkpoint_retry_loop() -> None:
    bridge = _make_bridge()
    checkpoint = json.dumps({"info": {"id": "ses_checkpoint"}, "messages": []}).encode()
    process = MagicMock(returncode=0)
    process.communicate = AsyncMock(return_value=(checkpoint, b""))
    upload_started = asyncio.Event()
    release_upload = asyncio.Event()
    response = MagicMock(status_code=201)

    async def put_checkpoint(*_args, **_kwargs):
        upload_started.set()
        await release_upload.wait()
        return response

    bridge.http_client.put = AsyncMock(side_effect=put_checkpoint)
    response.json.side_effect = lambda: {
        "status": "confirmed",
        "checkpointId": bridge.http_client.put.await_args.kwargs["headers"]["X-Checkpoint-ID"],
        "attemptId": bridge.http_client.put.await_args.kwargs["headers"]["X-Checkpoint-Attempt-ID"],
        "checksum": hashlib.sha256(checkpoint).hexdigest(),
    }

    with patch(
        "sandbox_runtime.bridge.asyncio.create_subprocess_exec",
        AsyncMock(return_value=process),
    ):
        original = asyncio.create_task(bridge._export_and_upload_checkpoint())
        await upload_started.wait()
        resumed = asyncio.create_task(bridge._resume_pending_checkpoint_or_report_failure())
        await asyncio.sleep(0)
        assert bridge.http_client.put.await_count == 1
        release_upload.set()
        await asyncio.gather(original, resumed)

    assert bridge.http_client.put.await_count == 1
    assert not bridge.checkpoint_pending_file.exists()


@pytest.mark.asyncio
async def test_bridge_restart_replays_terminal_checkpoint_until_ack(tmp_path: Path) -> None:
    checkpoint = json.dumps({"info": {"id": "ses_checkpoint"}, "messages": []}).encode()
    process = MagicMock(returncode=0)
    process.communicate = AsyncMock(return_value=(checkpoint, b""))
    first = _make_bridge()
    first.checkpoint_terminal_events_file = tmp_path / "checkpoint-events.json"
    response = MagicMock(status_code=201)
    first.http_client.put = AsyncMock(return_value=response)
    response.json.side_effect = lambda: {
        "status": "confirmed",
        "checkpointId": first.http_client.put.await_args.kwargs["headers"]["X-Checkpoint-ID"],
        "attemptId": first.http_client.put.await_args.kwargs["headers"]["X-Checkpoint-Attempt-ID"],
        "checksum": hashlib.sha256(checkpoint).hexdigest(),
    }

    with patch(
        "sandbox_runtime.bridge.asyncio.create_subprocess_exec",
        AsyncMock(return_value=process),
    ):
        await first._export_and_upload_checkpoint()

    assert first.checkpoint_terminal_events_file.exists()
    resumed = _make_bridge()
    resumed.checkpoint_terminal_events_file = first.checkpoint_terminal_events_file
    resumed.ws = MagicMock(state=1)
    resumed.ws.send = AsyncMock()

    await resumed._resume_checkpoint_terminal_events()

    replayed = json.loads(resumed.ws.send.await_args.args[0])
    assert replayed["type"] == "checkpoint"
    assert replayed["checkpointStatus"] == "confirmed"
    assert resumed.checkpoint_terminal_events_file.exists()

    await resumed._handle_command({"type": "ack", "ackId": replayed["ackId"]})

    assert not resumed.checkpoint_terminal_events_file.exists()
