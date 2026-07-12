"""Tests for OpenCode session reattach in the bridge.

Covers the OPENCODE_SESSION_ID env var path (control-plane-driven reattach on
resume), its precedence over the on-disk cache, and the GET verification that
falls back to a fresh session when the id no longer exists.
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
    async def test_clears_when_session_no_longer_exists(self, tmp_path: Path) -> None:
        with patch.dict("os.environ", {"OPENCODE_SESSION_ID": "oc-env"}, clear=False):
            bridge = _make_bridge()
        client = AsyncMock()
        client.get = AsyncMock(return_value=type("Resp", (), {"status_code": 404})())
        bridge.http_client = client

        await bridge._load_session_id()

        assert bridge.opencode_session_id is None

    @pytest.mark.asyncio
    async def test_no_id_leaves_fresh_session(self, tmp_path: Path) -> None:
        with patch.dict("os.environ", {}, clear=True):
            bridge = _make_bridge()
        bridge.session_id_file = tmp_path / "does-not-exist"
        bridge.http_client = _ok_client()

        await bridge._load_session_id()

        assert bridge.opencode_session_id is None
