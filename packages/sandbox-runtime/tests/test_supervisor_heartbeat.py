from unittest.mock import AsyncMock, MagicMock, patch

from sandbox_runtime.entrypoint import SandboxSupervisor


def make_supervisor() -> SandboxSupervisor:
    with patch.dict(
        "os.environ",
        {
            "SANDBOX_ID": "sandbox-1",
            "CONTROL_PLANE_URL": "https://control.example",
            "SANDBOX_AUTH_TOKEN": "secret-token",
            "SESSION_CONFIG": '{"session_id":"session-1"}',
        },
        clear=False,
    ):
        return SandboxSupervisor()


async def test_sends_allowlisted_process_and_cgroup_diagnostics() -> None:
    supervisor = make_supervisor()
    supervisor.boot_mode = "fresh"
    supervisor.boot_phase = "monitoring"
    supervisor.opencode_process = MagicMock(pid=10, returncode=None)
    supervisor.bridge_process = MagicMock(pid=11, returncode=-9)
    response = MagicMock(status_code=204)
    post = AsyncMock(return_value=response)
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=MagicMock(post=post))
    client.__aexit__ = AsyncMock(return_value=None)

    with (
        patch("sandbox_runtime.entrypoint.httpx.AsyncClient", return_value=client),
        patch("sandbox_runtime.entrypoint.read_cgroup_memory_diagnostics") as read_memory,
        patch(
            "sandbox_runtime.entrypoint.read_process_tree_rss_bytes",
            side_effect=lambda pid: 2048 if pid else None,
        ),
    ):
        read_memory.return_value = MagicMock(
            memory_current_bytes=1024,
            memory_max_bytes=4096,
            high_count=2,
            max_count=3,
            oom_count=1,
            oom_kill_count=1,
        )
        await supervisor._send_supervisor_heartbeat()

    post.assert_awaited_once()
    _, kwargs = post.await_args
    assert kwargs["headers"] == {"Authorization": "Bearer secret-token"}
    assert kwargs["json"]["processes"]["bridge"] == {
        "pid": 11,
        "running": False,
        "exitCode": -9,
        "treeRssBytes": None,
    }
    assert kwargs["json"]["processes"]["opencode"]["treeRssBytes"] == 2048
    assert kwargs["json"]["cgroup"]["highCount"] == 2
    assert kwargs["json"]["cgroup"]["maxCount"] == 3
    assert kwargs["json"]["cgroup"]["oomKillCount"] == 1
    assert "env" not in kwargs["json"]
    assert "command" not in kwargs["json"]


async def test_heartbeat_failure_does_not_stop_supervisor() -> None:
    supervisor = make_supervisor()
    client = MagicMock()
    client.__aenter__ = AsyncMock(side_effect=TimeoutError())
    client.__aexit__ = AsyncMock(return_value=None)

    with patch("sandbox_runtime.entrypoint.httpx.AsyncClient", return_value=client):
        await supervisor._send_supervisor_heartbeat()

    assert not supervisor.shutdown_event.is_set()
