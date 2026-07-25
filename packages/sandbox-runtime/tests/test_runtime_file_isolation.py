"""Tests for isolation from mutable files owned by a live sandbox runtime."""

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from sandbox_runtime import bridge, constants, entrypoint
from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.constants import TUNNEL_ENV_SANDBOX_ID_KEY
from sandbox_runtime.entrypoint import SandboxSupervisor
from sandbox_runtime.repo_config import RepoEntry


@pytest.mark.asyncio
async def test_runtime_file_operations_stay_under_each_test_directory(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENCODE_SESSION_ID", raising=False)

    supervisor = SandboxSupervisor()
    supervisor.sandbox_id = "test-sandbox"
    supervisor.repositories = [
        RepoEntry(owner="acme", name="app", branch="main", path=tmp_path / "app")
    ]
    agent_bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )

    supervisor._write_repo_manifest()
    manifest_path = Path(entrypoint.REPO_MANIFEST_FILE_PATH)
    assert json.loads(manifest_path.read_text())["repositories"][0]["name"] == "app"

    supervisor._record_boot_warning(scope="setup", message="isolated warning")
    warnings_path = Path(entrypoint.BOOT_WARNINGS_FILE_PATH)
    assert warnings_path.exists()
    agent_bridge._send_event = AsyncMock()
    await agent_bridge._drain_boot_warnings()
    assert not warnings_path.exists()
    agent_bridge._send_event.assert_awaited_once()

    tunnel_path = Path(entrypoint.TUNNEL_ENV_FILE_PATH)
    tunnel_contents = f"{TUNNEL_ENV_SANDBOX_ID_KEY}=test-sandbox\nTUNNEL_3000=https://example.com\n"
    tunnel_path.write_text(tunnel_contents)
    supervisor._clear_stale_tunnel_env_file()
    assert tunnel_path.read_text() == tunnel_contents

    agent_bridge.session_id_file.write_text("oc-isolated")
    await agent_bridge._load_session_id()
    assert agent_bridge.opencode_session_id == "oc-isolated"

    isolated_paths = {
        manifest_path,
        Path(bridge.REPO_MANIFEST_FILE_PATH),
        warnings_path,
        Path(bridge.BOOT_WARNINGS_FILE_PATH),
        tunnel_path,
        agent_bridge.session_id_file,
    }
    live_paths = {
        Path(constants.REPO_MANIFEST_FILE_PATH),
        Path(constants.BOOT_WARNINGS_FILE_PATH),
        Path(constants.TUNNEL_ENV_FILE_PATH),
        Path("/tmp/opencode-session-id"),
    }

    assert all(path.parent == tmp_path for path in isolated_paths)
    assert isolated_paths.isdisjoint(live_paths)
