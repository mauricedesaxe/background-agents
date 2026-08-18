"""A test run inside a live sandbox must not corrupt that sandbox's runtime files."""

import builtins
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from sandbox_runtime import boot_warnings, bridge, repository_boot, tunnel_environment
from sandbox_runtime.boot_warnings import BootWarningSink
from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.constants import (
    BOOT_WARNINGS_FILE_PATH,
    REPO_MANIFEST_FILE_PATH,
    TUNNEL_ENV_FILE_PATH,
    TUNNEL_ENV_SANDBOX_ID_KEY,
)
from sandbox_runtime.tunnel_environment import TunnelEnvironment
from tests.conftest import redirect_runtime_file_paths


class _Log:
    def __getattr__(self, name):
        return lambda *args, **kwargs: None


@pytest.mark.asyncio
async def test_runtime_file_operations_stay_under_each_test_directory(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENCODE_SESSION_ID", raising=False)

    redirect_runtime_file_paths(tmp_path, monkeypatch)

    fixture_paths = {
        Path(repository_boot.REPO_MANIFEST_FILE_PATH),
        Path(bridge.REPO_MANIFEST_FILE_PATH),
        Path(boot_warnings.BOOT_WARNINGS_FILE_PATH),
        Path(bridge.BOOT_WARNINGS_FILE_PATH),
        Path(tunnel_environment.TUNNEL_ENV_FILE_PATH),
    }
    assert all(path.parent == tmp_path for path in fixture_paths)

    live_root = tmp_path / "live-runtime"
    live_root.mkdir()
    live_sentinels = {
        live_root / "oi-repo-manifest.json": "live manifest",
        live_root / "oi-boot-warnings.jsonl": "live warning",
        live_root / ".tunnels.env": "live tunnel",
        live_root / "opencode-session-id": "live session",
    }
    guarded_live_paths = set(live_sentinels) | {
        Path(REPO_MANIFEST_FILE_PATH),
        Path(BOOT_WARNINGS_FILE_PATH),
        Path(TUNNEL_ENV_FILE_PATH),
        Path("/tmp/opencode-session-id"),
    }
    for path, contents in live_sentinels.items():
        path.write_text(contents)

    real_open = builtins.open
    real_read_text = Path.read_text
    real_write_text = Path.write_text
    real_unlink = Path.unlink

    def reject_live_open(file, *args, **kwargs):
        if isinstance(file, (str, Path)) and Path(file) in guarded_live_paths:
            raise AssertionError(f"accessed live runtime path: {file}")
        return real_open(file, *args, **kwargs)

    def reject_live_read(path, *args, **kwargs):
        if path in guarded_live_paths:
            raise AssertionError(f"read live runtime path: {path}")
        return real_read_text(path, *args, **kwargs)

    def reject_live_write(path, *args, **kwargs):
        if path in guarded_live_paths:
            raise AssertionError(f"wrote live runtime path: {path}")
        return real_write_text(path, *args, **kwargs)

    def reject_live_unlink(path, *args, **kwargs):
        if path in guarded_live_paths:
            raise AssertionError(f"unlinked live runtime path: {path}")
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", reject_live_open)
    monkeypatch.setattr(Path, "read_text", reject_live_read)
    monkeypatch.setattr(Path, "write_text", reject_live_write)
    monkeypatch.setattr(Path, "unlink", reject_live_unlink)

    log = _Log()

    warning_sink = BootWarningSink(log)
    warning_sink.record(scope="setup", message="isolated warning")
    warnings_path = Path(boot_warnings.BOOT_WARNINGS_FILE_PATH)
    assert warnings_path.exists()

    agent_bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    agent_bridge._send_event = AsyncMock()
    await agent_bridge._drain_boot_warnings()
    assert not warnings_path.exists()
    agent_bridge._send_event.assert_awaited_once()

    tunnel_path = Path(tunnel_environment.TUNNEL_ENV_FILE_PATH)
    tunnel_contents = f"{TUNNEL_ENV_SANDBOX_ID_KEY}=test-sandbox\nTUNNEL_3000=https://example.com\n"
    tunnel_path.write_text(tunnel_contents)
    TunnelEnvironment(sandbox_id="test-sandbox", log=log).clear_stale_file()
    assert tunnel_path.read_text() == tunnel_contents

    assert agent_bridge.session_id_file == tmp_path / "opencode-session-id"

    monkeypatch.setattr(builtins, "open", real_open)
    monkeypatch.setattr(Path, "read_text", real_read_text)
    monkeypatch.setattr(Path, "write_text", real_write_text)
    monkeypatch.setattr(Path, "unlink", real_unlink)

    isolated_paths = {
        Path(repository_boot.REPO_MANIFEST_FILE_PATH),
        Path(bridge.REPO_MANIFEST_FILE_PATH),
        Path(boot_warnings.BOOT_WARNINGS_FILE_PATH),
        Path(bridge.BOOT_WARNINGS_FILE_PATH),
        tunnel_path,
        agent_bridge.session_id_file,
    }
    assert all(path.parent == tmp_path for path in isolated_paths)
    assert isolated_paths.isdisjoint(guarded_live_paths)
    assert all(path.read_text() == contents for path, contents in live_sentinels.items())
