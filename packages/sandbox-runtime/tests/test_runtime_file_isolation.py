"""A test run inside a live sandbox must not corrupt that sandbox's runtime files."""

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from sandbox_runtime import bridge, constants, entrypoint
from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.constants import TUNNEL_ENV_SANDBOX_ID_KEY
from sandbox_runtime.entrypoint import SandboxSupervisor
from sandbox_runtime.repo_config import RepoEntry
from tests.conftest import redirect_runtime_file_paths


@pytest.mark.asyncio
async def test_runtime_file_operations_stay_under_each_test_directory(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENCODE_SESSION_ID", raising=False)

    live_root = tmp_path / "live-runtime"
    live_root.mkdir()
    live_sentinels = {
        live_root / "oi-repo-manifest.json": "live manifest",
        live_root / "oi-boot-warnings.jsonl": "live warning",
        live_root / ".tunnels.env": "live tunnel",
        live_root / "opencode-session-id": "live session",
    }
    for path, contents in live_sentinels.items():
        path.write_text(contents)

    live_manifest_path, live_warnings_path, live_tunnel_path, _ = live_sentinels
    monkeypatch.setattr(entrypoint, "REPO_MANIFEST_FILE_PATH", str(live_manifest_path))
    monkeypatch.setattr(bridge, "REPO_MANIFEST_FILE_PATH", str(live_manifest_path))
    monkeypatch.setattr(entrypoint, "BOOT_WARNINGS_FILE_PATH", str(live_warnings_path))
    monkeypatch.setattr(bridge, "BOOT_WARNINGS_FILE_PATH", str(live_warnings_path))
    monkeypatch.setattr(entrypoint, "TUNNEL_ENV_FILE_PATH", str(live_tunnel_path))
    monkeypatch.setattr(bridge.tempfile, "tempdir", str(live_root))

    redirect_runtime_file_paths(tmp_path, monkeypatch)

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
    } | set(live_sentinels)

    assert all(path.parent == tmp_path for path in isolated_paths)
    assert isolated_paths.isdisjoint(live_paths)
    assert all(path.read_text() == contents for path, contents in live_sentinels.items())
