import json
from unittest.mock import AsyncMock, MagicMock, patch

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
    bridge._save_checkpoint = AsyncMock(side_effect=lambda: observed.append("checkpoint"))
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
    bridge._save_checkpoint = AsyncMock(side_effect=RuntimeError("upload failed"))
    bridge._send_event = AsyncMock(side_effect=sent.append)

    await bridge._handle_prompt({"messageId": "msg-1", "content": "continue"})

    assert any(event["type"] == "warning" and event["scope"] == "checkpoint" for event in sent)
    assert sent[-1] == {
        "type": "execution_complete",
        "messageId": "msg-1",
        "success": True,
    }


@pytest.mark.asyncio
async def test_checkpoint_upload_uses_native_export_without_replaying_messages() -> None:
    bridge = _make_bridge()
    checkpoint = json.dumps({"info": {"id": "ses_checkpoint"}, "messages": []}).encode()
    process = MagicMock(returncode=0)
    process.communicate = AsyncMock(return_value=(checkpoint, b""))
    response = MagicMock(status_code=201)
    response.raise_for_status = MagicMock()
    bridge.http_client.put = AsyncMock(return_value=response)

    with patch(
        "sandbox_runtime.bridge.asyncio.create_subprocess_exec",
        AsyncMock(return_value=process),
    ) as create_process:
        await bridge._save_checkpoint()

    create_process.assert_awaited_once()
    args = create_process.await_args.args
    assert args[:3] == ("opencode", "export", "ses_checkpoint")
    assert "--pure" in args
    bridge.http_client.put.assert_awaited_once()
    request = bridge.http_client.put.await_args
    assert request.args[0].endswith("/sessions/test-session/checkpoint")
    assert request.kwargs["content"] == checkpoint
    assert request.kwargs["headers"]["Authorization"] == "Bearer test-token"
