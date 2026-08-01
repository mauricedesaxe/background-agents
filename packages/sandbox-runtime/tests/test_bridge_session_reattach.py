"""Tests for OpenCode session reattach in the bridge.

Covers the OPENCODE_SESSION_ID env var path (control-plane-driven reattach on
resume), its precedence over the on-disk cache, and the GET verification that
refuses to discard control-plane-owned conversation context.
"""

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

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
    async def test_blocks_session_that_failed_checkpoint_graph_verification(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "OPENCODE_SESSION_ID": "oc-env",
                "OPENCODE_CONTEXT_STATUS": "unavailable",
            },
            clear=False,
        ):
            bridge = _make_bridge()
            bridge.http_client = _ok_client()
            await bridge._load_session_id()

        assert bridge.opencode_session_error == (
            "OpenCode session oc-env failed checkpoint verification; "
            "refusing to continue without its complete conversation context"
        )

    @pytest.mark.asyncio
    async def test_failed_reattach_rejects_prompt_without_running_agent(self) -> None:
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
    async def test_no_id_leaves_fresh_session(self, tmp_path: Path) -> None:
        with patch.dict("os.environ", {}, clear=True):
            bridge = _make_bridge()
        bridge.session_id_file = tmp_path / "does-not-exist"
        bridge.http_client = _ok_client()

        await bridge._load_session_id()

        assert bridge.opencode_session_id is None
