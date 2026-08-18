from unittest.mock import AsyncMock, MagicMock, patch

from sandbox_runtime.entrypoint import SandboxSupervisor


def _make_config(**overrides):
    cfg = MagicMock()
    cfg.control_plane_url = ""
    cfg.sandbox_token = ""
    cfg.sandbox_id = "sandbox-1"
    cfg.repo_owner = "acme"
    cfg.repo_name = "app"
    cfg.session_config = {}
    for k, v in overrides.items():
        if k in ("session_id",):
            cfg.session_config[k] = v
        else:
            setattr(cfg, k, v)
    return cfg


def _make_supervisor(**config_overrides):
    supervisor = SandboxSupervisor(
        config=_make_config(**config_overrides),
        repository_boot=MagicMock(),
        opencode_server=MagicMock(),
        agent_bridge=MagicMock(),
        code_server=MagicMock(),
        web_terminal=MagicMock(),
        browser_desktop=MagicMock(),
        managed_skills=None,
        shutdown_event=MagicMock(),
        log=MagicMock(),
    )
    supervisor.shutdown_event.is_set.return_value = False
    return supervisor


async def test_sends_allowlisted_process_and_cgroup_diagnostics() -> None:
    supervisor = _make_supervisor(
        control_plane_url="https://control.example",
        sandbox_token="secret-token",
        session_id="session-1",
    )
    supervisor.boot_phase = "monitoring"
    supervisor.opencode_server.pid.return_value = 10
    supervisor.opencode_server.exit_code.return_value = None
    supervisor.agent_bridge.pid.return_value = 11
    supervisor.agent_bridge.exit_code.return_value = -9
    response = MagicMock(status_code=204)
    post = AsyncMock(return_value=response)
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=MagicMock(post=post))
    client.__aexit__ = AsyncMock(return_value=None)

    with (
        patch("sandbox_runtime.supervisor.httpx.AsyncClient", return_value=client),
        patch("sandbox_runtime.supervisor.read_cgroup_memory_diagnostics") as read_memory,
        patch(
            "sandbox_runtime.supervisor.read_process_tree_rss_bytes",
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


async def test_heartbeat_failure_does_not_stop_supervisor() -> None:
    supervisor = _make_supervisor(
        control_plane_url="https://control.example",
        session_id="session-1",
        sandbox_token="secret-token",
    )
    client = MagicMock()
    client.__aenter__ = AsyncMock(side_effect=TimeoutError())
    client.__aexit__ = AsyncMock(return_value=None)

    with patch("sandbox_runtime.supervisor.httpx.AsyncClient", return_value=client):
        await supervisor._send_supervisor_heartbeat()

    assert not supervisor.shutdown_event.is_set()
