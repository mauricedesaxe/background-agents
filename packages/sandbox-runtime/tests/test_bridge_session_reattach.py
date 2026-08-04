"""Tests for OpenCode session reattach in the bridge.

Covers the OPENCODE_SESSION_ID env var path (control-plane-driven reattach on
resume), its precedence over the on-disk cache, and the GET verification that
refuses to discard control-plane-owned conversation context.
"""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from websockets.asyncio.server import ServerConnection, serve

from sandbox_runtime.bridge import AgentBridge


def _make_bridge() -> AgentBridge:
    return AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )


def _ok_client() -> AsyncMock:
    client = AsyncMock()
    client.get = AsyncMock(return_value=type("Resp", (), {"status_code": 200})())
    return client


class TestSessionReattach:
    @pytest.mark.asyncio
    async def test_verification_restart_closes_http_client(self) -> None:
        bridge = _make_bridge()
        bridge._load_session_id = AsyncMock(side_effect=RuntimeError("verification failed"))
        client = AsyncMock()

        with (
            patch("sandbox_runtime.bridge.httpx.AsyncClient", return_value=client),
            pytest.raises(RuntimeError, match="verification failed"),
        ):
            await bridge.run()

        client.aclose.assert_awaited_once()

    def test_env_var_captured_in_init(self) -> None:
        with patch.dict("os.environ", {"OPENCODE_SESSION_ID": "oc-env"}, clear=False):
            bridge = _make_bridge()
        assert bridge.provided_opencode_session_id == "oc-env"

    def test_empty_env_var_treated_as_absent(self) -> None:
        with patch.dict("os.environ", {"OPENCODE_SESSION_ID": ""}, clear=False):
            bridge = _make_bridge()
        assert bridge.provided_opencode_session_id is None

    @pytest.mark.asyncio
    async def test_prefers_env_over_file(self, tmp_path: Path) -> None:
        with patch.dict("os.environ", {"OPENCODE_SESSION_ID": "oc-env"}, clear=False):
            bridge = _make_bridge()
        bridge.session_id_file = tmp_path / "opencode-session-id"
        bridge.session_id_file.write_text("oc-file")
        bridge.http_client = _ok_client()

        await bridge._load_session_id()

        assert bridge.opencode_session_id == "oc-env"

    @pytest.mark.asyncio
    async def test_falls_back_to_file_without_env(self, tmp_path: Path) -> None:
        with patch.dict("os.environ", {}, clear=True):
            bridge = _make_bridge()
        bridge.session_id_file = tmp_path / "opencode-session-id"
        bridge.session_id_file.write_text("oc-file")
        bridge.http_client = _ok_client()

        await bridge._load_session_id()

        assert bridge.opencode_session_id == "oc-file"

    @pytest.mark.asyncio
    async def test_blocks_resume_when_control_plane_session_no_longer_exists(
        self, tmp_path: Path
    ) -> None:
        with patch.dict("os.environ", {"OPENCODE_SESSION_ID": "oc-env"}, clear=False):
            bridge = _make_bridge()
        client = AsyncMock()
        client.get = AsyncMock(return_value=type("Resp", (), {"status_code": 404})())
        bridge.http_client = client

        await bridge._load_session_id()

        assert client.get.await_count == 1
        assert bridge.opencode_session_id == "oc-env"
        assert bridge.opencode_session_error == (
            "OpenCode session oc-env is unavailable; "
            "refusing to continue without its conversation context"
        )

    @pytest.mark.asyncio
    async def test_blocks_resume_when_local_session_no_longer_exists(self, tmp_path: Path) -> None:
        with patch.dict("os.environ", {}, clear=True):
            bridge = _make_bridge()
        bridge.session_id_file = tmp_path / "opencode-session-id"
        bridge.session_id_file.write_text("oc-file")
        client = AsyncMock()
        client.get = AsyncMock(return_value=type("Resp", (), {"status_code": 404})())
        bridge.http_client = client

        await bridge._load_session_id()

        assert bridge.opencode_session_id == "oc-file"
        assert bridge.opencode_session_error is not None

    @pytest.mark.asyncio
    async def test_retries_transient_timeout_before_blocking_resume(self) -> None:
        with patch.dict("os.environ", {"OPENCODE_SESSION_ID": "oc-env"}, clear=False):
            bridge = _make_bridge()
        client = AsyncMock()
        client.get = AsyncMock(
            side_effect=[
                httpx.ReadTimeout("OpenCode is still loading the imported session"),
                type("Resp", (), {"status_code": 200})(),
            ]
        )
        bridge.http_client = client
        bridge.SESSION_VERIFY_RETRY_DELAY_SECONDS = 0

        await bridge._load_session_id()

        assert client.get.await_count == 2
        assert all(call.kwargs["timeout"] == 10 for call in client.get.await_args_list)
        assert bridge.opencode_session_id == "oc-env"
        assert bridge.opencode_session_error is None

    @pytest.mark.asyncio
    async def test_restarts_after_session_verification_timeouts_are_exhausted(self) -> None:
        with patch.dict("os.environ", {"OPENCODE_SESSION_ID": "oc-env"}, clear=False):
            bridge = _make_bridge()
        client = AsyncMock()
        client.get = AsyncMock(
            side_effect=[
                httpx.ReadTimeout("OpenCode is still loading the imported session"),
                httpx.ReadTimeout("OpenCode did not finish loading the imported session"),
            ]
        )
        bridge.http_client = client
        bridge.SESSION_VERIFY_RETRY_DELAY_SECONDS = 0

        with pytest.raises(RuntimeError, match="Could not verify OpenCode session oc-env"):
            await bridge._load_session_id()

        assert client.get.await_count == 2
        assert bridge.opencode_session_error is None

    @pytest.mark.asyncio
    async def test_retries_connection_errors_without_reporting_context_loss(self) -> None:
        with patch.dict("os.environ", {"OPENCODE_SESSION_ID": "oc-env"}, clear=False):
            bridge = _make_bridge()
        client = AsyncMock()
        client.get = AsyncMock(side_effect=httpx.ConnectError("OpenCode connection failed"))
        bridge.http_client = client
        bridge.SESSION_VERIFY_RETRY_DELAY_SECONDS = 0

        with pytest.raises(RuntimeError, match="Could not verify OpenCode session oc-env"):
            await bridge._load_session_id()

        assert client.get.await_count == 2
        assert bridge.opencode_session_error is None

    @pytest.mark.asyncio
    async def test_retries_server_errors_without_reporting_context_loss(self) -> None:
        with patch.dict("os.environ", {"OPENCODE_SESSION_ID": "oc-env"}, clear=False):
            bridge = _make_bridge()
        client = AsyncMock()
        client.get = AsyncMock(return_value=type("Resp", (), {"status_code": 503})())
        bridge.http_client = client
        bridge.SESSION_VERIFY_RETRY_DELAY_SECONDS = 0

        with pytest.raises(RuntimeError, match="Could not verify OpenCode session oc-env"):
            await bridge._load_session_id()

        assert client.get.await_count == 2
        assert bridge.opencode_session_error is None

    @pytest.mark.asyncio
    async def test_context_failure_keeps_one_identity_across_reconnects(self) -> None:
        received: list[dict[str, object]] = []

        async def receive_failure(websocket: ServerConnection) -> None:
            while True:
                try:
                    raw = await asyncio.wait_for(websocket.recv(), timeout=0.05)
                except TimeoutError:
                    break
                received.append(json.loads(raw))
            await websocket.close()

        bridge = _make_bridge()
        bridge.opencode_session_id = "oc-env"
        bridge.opencode_session_error = "The expected OpenCode session is unavailable"

        async with serve(receive_failure, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            bridge.control_plane_url = f"http://127.0.0.1:{port}"
            await bridge._connect_and_run()
            await bridge._connect_and_run()

        assert [event["type"] for event in received] == [
            "context_unavailable",
            "context_unavailable",
        ]
        assert received[0]["ackId"] == received[1]["ackId"]

    @pytest.mark.asyncio
    async def test_fresh_replacement_rejects_prompt_without_running_agent(self) -> None:
        bridge = _make_bridge()
        bridge.opencode_session_id = "oc-env"
        bridge.opencode_session_error = (
            "OpenCode session oc-env is unavailable; "
            "refusing to continue without its conversation context"
        )
        bridge._create_opencode_session = AsyncMock()
        bridge._send_event = AsyncMock()

        await bridge._handle_prompt({"messageId": "message-1", "content": "continue"})

        bridge._create_opencode_session.assert_not_awaited()
        bridge._send_event.assert_awaited_once_with(
            {
                "type": "execution_complete",
                "messageId": "message-1",
                "success": False,
                "error": (
                    "OpenCode session oc-env is unavailable; "
                    "refusing to continue without its conversation context"
                ),
            }
        )

    @pytest.mark.asyncio
    async def test_new_session_reports_id_without_waiting_for_reconnect(self) -> None:
        bridge = _make_bridge()
        client = AsyncMock()
        client.post = AsyncMock(
            return_value=type(
                "Resp",
                (),
                {"raise_for_status": lambda self: None, "json": lambda self: {"id": "oc-new"}},
            )()
        )
        bridge.http_client = client
        bridge._send_event = AsyncMock()

        await bridge._create_opencode_session()

        bridge._send_event.assert_awaited_once_with(
            {
                "type": "opencode_session_created",
                "sandboxId": "test-sandbox",
                "opencodeSessionId": "oc-new",
            }
        )

    @pytest.mark.asyncio
    async def test_same_sandbox_reports_the_session_resumed_from_disk(self, tmp_path: Path) -> None:
        received: list[dict[str, object]] = []

        async def receive_ready(websocket: ServerConnection) -> None:
            raw = await websocket.recv()
            received.append(json.loads(raw))
            await websocket.close()

        with patch.dict("os.environ", {}, clear=True):
            bridge = _make_bridge()
            bridge.session_id_file = tmp_path / "opencode-session-id"
            bridge.session_id_file.write_text("oc-existing")
            bridge.http_client = _ok_client()
            await bridge._load_session_id()

            async with serve(receive_ready, "127.0.0.1", 0) as server:
                port = server.sockets[0].getsockname()[1]
                bridge.control_plane_url = f"http://127.0.0.1:{port}"
                await bridge._connect_and_run()

        ready = received[0]
        assert ready == {
            "type": "ready",
            "sandboxId": "test-sandbox",
            "opencodeSessionId": "oc-existing",
            "contextStatus": "existing",
            "timestamp": ready["timestamp"],
        }

    @pytest.mark.asyncio
    async def test_no_id_leaves_fresh_session(self, tmp_path: Path) -> None:
        with patch.dict("os.environ", {}, clear=True):
            bridge = _make_bridge()
        bridge.session_id_file = tmp_path / "does-not-exist"
        bridge.http_client = _ok_client()

        await bridge._load_session_id()

        assert bridge.opencode_session_id is None
