"""Tests for bridge git push handling."""

import asyncio
import json
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.bridge import AgentBridge


def _create_bridge(tmp_path: Path) -> AgentBridge:
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    bridge.repo_path = tmp_path
    # Point at a per-test manifest (absent until a test writes one) so the
    # real /tmp manifest never leaks in.
    bridge.repo_manifest_path = tmp_path / "manifest.json"
    repo_dir = tmp_path / "repo"
    (repo_dir / ".git").mkdir(parents=True)
    return bridge


def _write_manifest(bridge: AgentBridge, tmp_path: Path, members: list[tuple[str, str]]) -> None:
    """Write the supervisor-style repo manifest for the given (owner, name) members."""
    bridge.repo_manifest_path.write_text(
        json.dumps(
            {
                "repositories": [
                    {
                        "owner": owner,
                        "name": name,
                        "branch": "main",
                        "path": str(tmp_path / name),
                    }
                    for owner, name in members
                ]
            }
        )
    )


def _push_command() -> dict:
    return {
        "type": "push",
        "pushSpec": {
            "targetBranch": "feature/test",
            "refspec": "HEAD:refs/heads/feature/test",
            "remoteUrl": "https://token@github.com/open-inspect/repo.git",
            "redactedRemoteUrl": "https://***@github.com/open-inspect/repo.git",
            "force": False,
        },
    }


def _fake_process(returncode: int | None, communicate_result: tuple[bytes, bytes] = (b"", b"")):
    process = MagicMock()
    process.returncode = returncode
    process.communicate = AsyncMock(return_value=communicate_result)
    process.wait = AsyncMock(return_value=None)
    process.terminate = MagicMock()
    process.kill = MagicMock()
    return process


@pytest.mark.asyncio
async def test_handle_push_sends_push_complete_on_success(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    bridge._send_event = AsyncMock()
    process = _fake_process(returncode=0)

    with patch(
        "sandbox_runtime.bridge.asyncio.create_subprocess_exec", AsyncMock(return_value=process)
    ):
        await bridge._handle_push(_push_command())

    bridge._send_event.assert_awaited_once()
    await_args = bridge._send_event.await_args
    assert await_args is not None
    event = await_args.args[0]
    assert event["type"] == "push_complete"
    assert event["branchName"] == "feature/test"
    assert isinstance(event["timestamp"], float)
    process.terminate.assert_not_called()
    process.kill.assert_not_called()


@pytest.mark.asyncio
async def test_handle_push_sends_redacted_stderr_on_nonzero_exit(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    bridge._send_event = AsyncMock()
    process = _fake_process(
        returncode=1,
        communicate_result=(
            b"",
            b"fatal: Authentication failed for 'https://token@github.com/open-inspect/repo.git'",
        ),
    )

    with patch(
        "sandbox_runtime.bridge.asyncio.create_subprocess_exec", AsyncMock(return_value=process)
    ):
        await bridge._handle_push(_push_command())

    bridge._send_event.assert_awaited_once()
    await_args = bridge._send_event.await_args
    assert await_args is not None
    event = await_args.args[0]
    assert event["type"] == "push_error"
    assert (
        event["error"]
        == "Push failed: fatal: Authentication failed for 'https://***@github.com/open-inspect/repo.git'"
    )
    assert event["branchName"] == "feature/test"
    assert isinstance(event["timestamp"], float)
    process.terminate.assert_not_called()
    process.kill.assert_not_called()


@pytest.mark.asyncio
async def test_handle_push_sends_unknown_error_when_stderr_is_empty(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    bridge._send_event = AsyncMock()
    process = _fake_process(returncode=1)

    with patch(
        "sandbox_runtime.bridge.asyncio.create_subprocess_exec", AsyncMock(return_value=process)
    ):
        await bridge._handle_push(_push_command())

    bridge._send_event.assert_awaited_once()
    await_args = bridge._send_event.await_args
    assert await_args is not None
    event = await_args.args[0]
    assert event["type"] == "push_error"
    assert event["error"] == "Push failed - unknown error"
    assert event["branchName"] == "feature/test"
    assert isinstance(event["timestamp"], float)


@pytest.mark.asyncio
async def test_handle_push_timeout_terminates_process_and_sends_error(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    bridge._send_event = AsyncMock()
    bridge.GIT_PUSH_TIMEOUT_SECONDS = 42.0
    bridge.GIT_PUSH_TERMINATE_GRACE_SECONDS = 3.0

    process = _fake_process(returncode=None)
    wait_for_calls: list[float | None] = []
    original_wait_for = asyncio.wait_for

    async def timeout_first_wait_for(coro, timeout=None):
        wait_for_calls.append(timeout)
        if len(wait_for_calls) == 1:
            if hasattr(coro, "close"):
                coro.close()
            raise TimeoutError
        return await original_wait_for(coro, timeout=timeout)

    with (
        patch(
            "sandbox_runtime.bridge.asyncio.create_subprocess_exec", AsyncMock(return_value=process)
        ),
        patch("sandbox_runtime.bridge.asyncio.wait_for", side_effect=timeout_first_wait_for),
    ):
        await bridge._handle_push(_push_command())

    assert wait_for_calls == [42.0, 3.0]
    process.terminate.assert_called_once()
    process.wait.assert_awaited_once()
    process.kill.assert_not_called()
    bridge._send_event.assert_awaited_once()
    await_args = bridge._send_event.await_args
    assert await_args is not None
    event = await_args.args[0]
    assert event["type"] == "push_error"
    assert event["error"] == "Push failed - git push timed out after 42s"
    assert event["branchName"] == "feature/test"
    assert isinstance(event["timestamp"], float)


def _multi_repo_push_command() -> dict:
    cmd = _push_command()
    cmd["pushSpec"]["repoOwner"] = "open-inspect"
    cmd["pushSpec"]["repoName"] = "backend"
    return cmd


@pytest.mark.asyncio
async def test_handle_push_targets_member_from_spec(tmp_path: Path):
    """A spec carrying repo identity pushes from that member's checkout."""
    bridge = _create_bridge(tmp_path)  # creates tmp_path/repo/.git
    _write_manifest(bridge, tmp_path, [("open-inspect", "frontend"), ("open-inspect", "backend")])
    (tmp_path / "backend" / ".git").mkdir(parents=True)
    bridge._send_event = AsyncMock()
    process = _fake_process(returncode=0)
    captured: dict = {}

    async def fake_exec(*args, **kwargs):
        captured["cwd"] = kwargs.get("cwd")
        return process

    with patch("sandbox_runtime.bridge.asyncio.create_subprocess_exec", side_effect=fake_exec):
        await bridge._handle_push(_multi_repo_push_command())

    assert captured["cwd"] == tmp_path / "backend"
    event = bridge._send_event.await_args.args[0]
    assert event["type"] == "push_complete"
    assert event["branchName"] == "feature/test"
    assert event["repoOwner"] == "open-inspect"
    assert event["repoName"] == "backend"


@pytest.mark.asyncio
async def test_handle_push_matches_member_case_insensitively(tmp_path: Path):
    """Identity matching is case-insensitive but the canonical path is used."""
    bridge = _create_bridge(tmp_path)
    _write_manifest(bridge, tmp_path, [("open-inspect", "backend")])
    (tmp_path / "backend" / ".git").mkdir(parents=True)
    bridge._send_event = AsyncMock()
    process = _fake_process(returncode=0)
    captured: dict = {}

    async def fake_exec(*args, **kwargs):
        captured["cwd"] = kwargs.get("cwd")
        return process

    cmd = _multi_repo_push_command()
    cmd["pushSpec"]["repoOwner"] = "Open-Inspect"
    cmd["pushSpec"]["repoName"] = "Backend"

    with patch("sandbox_runtime.bridge.asyncio.create_subprocess_exec", side_effect=fake_exec):
        await bridge._handle_push(cmd)

    assert captured["cwd"] == tmp_path / "backend"
    event = bridge._send_event.await_args.args[0]
    assert event["type"] == "push_complete"


@pytest.mark.asyncio
async def test_handle_push_non_member_errors_without_pushing(tmp_path: Path):
    """Identity not in the manifest never touches the filesystem."""
    bridge = _create_bridge(tmp_path)
    _write_manifest(bridge, tmp_path, [("open-inspect", "backend")])
    bridge._send_event = AsyncMock()
    cmd = _multi_repo_push_command()
    cmd["pushSpec"]["repoName"] = "missing"

    with patch("sandbox_runtime.bridge.asyncio.create_subprocess_exec") as mock_exec:
        await bridge._handle_push(cmd)

    mock_exec.assert_not_called()
    event = bridge._send_event.await_args.args[0]
    assert event["type"] == "push_error"
    assert "not part of this session" in event["error"]
    assert event["branchName"] == "feature/test"
    assert event["repoName"] == "missing"


@pytest.mark.asyncio
async def test_handle_push_traversal_repo_name_errors_without_pushing(tmp_path: Path):
    """A crafted path-segment identity cannot select a checkout outside the manifest."""
    bridge = _create_bridge(tmp_path)
    _write_manifest(bridge, tmp_path, [("open-inspect", "backend")])
    outside = tmp_path / "outside"
    (outside / ".git").mkdir(parents=True)
    bridge._send_event = AsyncMock()
    cmd = _multi_repo_push_command()
    cmd["pushSpec"]["repoName"] = "../outside"

    with patch("sandbox_runtime.bridge.asyncio.create_subprocess_exec") as mock_exec:
        await bridge._handle_push(cmd)

    mock_exec.assert_not_called()
    event = bridge._send_event.await_args.args[0]
    assert event["type"] == "push_error"
    assert "not part of this session" in event["error"]


@pytest.mark.asyncio
@pytest.mark.parametrize("dropped_field", ["repoOwner", "repoName"])
async def test_handle_push_partial_identity_errors(tmp_path: Path, dropped_field: str):
    """Owner and name must travel together — no silent fallback for half a spec."""
    bridge = _create_bridge(tmp_path)
    _write_manifest(bridge, tmp_path, [("open-inspect", "backend")])
    bridge._send_event = AsyncMock()
    cmd = _multi_repo_push_command()
    del cmd["pushSpec"][dropped_field]

    with patch("sandbox_runtime.bridge.asyncio.create_subprocess_exec") as mock_exec:
        await bridge._handle_push(cmd)

    mock_exec.assert_not_called()
    event = bridge._send_event.await_args.args[0]
    assert event["type"] == "push_error"
    assert "both repoOwner and repoName" in event["error"]
    assert event["branchName"] == "feature/test"


@pytest.mark.asyncio
async def test_handle_push_member_without_checkout_errors(tmp_path: Path):
    """A manifest member whose checkout is missing on disk fails cleanly."""
    bridge = _create_bridge(tmp_path)
    _write_manifest(bridge, tmp_path, [("open-inspect", "backend")])
    bridge._send_event = AsyncMock()

    with patch("sandbox_runtime.bridge.asyncio.create_subprocess_exec") as mock_exec:
        await bridge._handle_push(_multi_repo_push_command())

    mock_exec.assert_not_called()
    event = bridge._send_event.await_args.args[0]
    assert event["type"] == "push_error"
    assert "not found in workspace" in event["error"]
    assert event["repoName"] == "backend"


@pytest.mark.asyncio
async def test_handle_push_without_identity_keeps_legacy_behavior(tmp_path: Path):
    """Specs without repo identity push from the sole clone, no repo fields."""
    bridge = _create_bridge(tmp_path)
    bridge._send_event = AsyncMock()
    process = _fake_process(returncode=0)
    captured: dict = {}

    async def fake_exec(*args, **kwargs):
        captured["cwd"] = kwargs.get("cwd")
        return process

    with patch("sandbox_runtime.bridge.asyncio.create_subprocess_exec", side_effect=fake_exec):
        await bridge._handle_push(_push_command())

    assert captured["cwd"] == tmp_path / "repo"
    event = bridge._send_event.await_args.args[0]
    assert event["type"] == "push_complete"
    assert "repoOwner" not in event
    assert "repoName" not in event


@pytest.mark.asyncio
async def test_handle_push_no_repo_error_includes_branch(tmp_path: Path):
    """The no-repository error must carry branchName so the control plane can
    resolve its pending push instead of leaking it for 360s."""
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    bridge.repo_path = tmp_path  # no clones at all
    bridge._send_event = AsyncMock()

    await bridge._handle_push(_push_command())

    event = bridge._send_event.await_args.args[0]
    assert event["type"] == "push_error"
    assert event["error"] == "No repository found"
    assert event["branchName"] == "feature/test"


def _run_jj(cwd: Path, *args: str) -> str:
    """Run a real jj command for the jj-colocated fixtures below."""
    result = subprocess.run(["jj", *args], cwd=cwd, check=True, capture_output=True, text=True)
    return result.stdout


def _jj_colocated_clone(tmp_path: Path) -> Path:
    """A jj-colocated clone whose trunk() resolves, like a session checkout.

    trunk() falls back to root() without an origin remote, which would make
    the empty-push guard unfalsifiable, so the fixture clones a real origin.
    """
    origin = tmp_path / "origin"
    origin.mkdir()
    _run_jj(origin, "git", "init", "--colocate", ".")
    (origin / "a.txt").write_text("base\n")
    _run_jj(origin, "commit", "-m", "chore: base")
    _run_jj(origin, "bookmark", "set", "main", "-r", "@-")

    # The clone sits alone under a workspace root the origin is not part of,
    # because _sole_workspace_checkout picks the first clone it globs there.
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    work = workspace / "repo"
    _run_jj(tmp_path, "git", "clone", "--colocate", str(origin), str(work))
    return work


def _bridge_for_checkout(tmp_path: Path, checkout: Path) -> AgentBridge:
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    bridge.repo_path = checkout.parent
    bridge.repo_manifest_path = tmp_path / "manifest.json"
    return bridge


def _capture_git_push(process):
    """Let jj run for real and intercept only the git push subprocess."""
    captured: dict = {}
    real_exec = asyncio.create_subprocess_exec

    async def fake_exec(*args, **kwargs):
        if args[0] == "git":
            captured["argv"] = list(args)
            return process
        return await real_exec(*args, **kwargs)

    return captured, fake_exec


@pytest.mark.asyncio
async def test_handle_push_publishes_work_held_in_the_jj_working_copy(tmp_path: Path):
    """In a jj checkout the push carries `@`, which git HEAD does not contain."""
    work = _jj_colocated_clone(tmp_path)
    (work / "a.txt").write_text("base\nthe session's work\n")

    bridge = _bridge_for_checkout(tmp_path, work)
    bridge._send_event = AsyncMock()
    captured, fake_exec = _capture_git_push(_fake_process(returncode=0))

    with patch("sandbox_runtime.bridge.asyncio.create_subprocess_exec", side_effect=fake_exec):
        await bridge._handle_push(_push_command())

    event = bridge._send_event.await_args.args[0]
    assert event["type"] == "push_complete"

    refspec = captured["argv"][3]
    assert refspec == "refs/heads/feature/test:refs/heads/feature/test"

    pushed = subprocess.run(
        ["git", "show", "refs/heads/feature/test:a.txt"],
        cwd=work,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    assert "the session's work" in pushed

    # The ref git HEAD names is the parent of `@`, and it is exactly the
    # empty branch the old refspec published.
    stale = subprocess.run(
        ["git", "show", "HEAD:a.txt"], cwd=work, check=True, capture_output=True, text=True
    ).stdout
    assert "the session's work" not in stale


@pytest.mark.asyncio
async def test_handle_push_publishes_work_committed_with_jj(tmp_path: Path):
    """After `jj commit` the tip is `@-`, since jj leaves `@` empty."""
    work = _jj_colocated_clone(tmp_path)
    (work / "a.txt").write_text("base\ncommitted work\n")
    _run_jj(work, "commit", "-m", "feat: committed work")

    bridge = _bridge_for_checkout(tmp_path, work)
    bridge._send_event = AsyncMock()
    captured, fake_exec = _capture_git_push(_fake_process(returncode=0))

    with patch("sandbox_runtime.bridge.asyncio.create_subprocess_exec", side_effect=fake_exec):
        await bridge._handle_push(_push_command())

    assert bridge._send_event.await_args.args[0]["type"] == "push_complete"
    assert captured["argv"][3] == "refs/heads/feature/test:refs/heads/feature/test"

    pushed = subprocess.run(
        ["git", "show", "refs/heads/feature/test:a.txt"],
        cwd=work,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    assert "committed work" in pushed


@pytest.mark.asyncio
async def test_handle_push_rejects_a_jj_checkout_with_no_work(tmp_path: Path):
    """A push that would publish an empty branch fails instead of reporting success."""
    work = _jj_colocated_clone(tmp_path)

    bridge = _bridge_for_checkout(tmp_path, work)
    bridge._send_event = AsyncMock()
    captured, fake_exec = _capture_git_push(_fake_process(returncode=0))

    with patch("sandbox_runtime.bridge.asyncio.create_subprocess_exec", side_effect=fake_exec):
        await bridge._handle_push(_push_command())

    event = bridge._send_event.await_args.args[0]
    assert event["type"] == "push_error"
    assert "no commits beyond trunk()" in event["error"]
    assert event["branchName"] == "feature/test"
    assert "argv" not in captured


@pytest.mark.asyncio
async def test_handle_push_leaves_the_refspec_alone_in_a_git_checkout(tmp_path: Path):
    """A checkout without .jj keeps the control plane's HEAD refspec."""
    bridge = _create_bridge(tmp_path)
    bridge._send_event = AsyncMock()
    captured, fake_exec = _capture_git_push(_fake_process(returncode=0))

    with patch("sandbox_runtime.bridge.asyncio.create_subprocess_exec", side_effect=fake_exec):
        await bridge._handle_push(_push_command())

    assert bridge._send_event.await_args.args[0]["type"] == "push_complete"
    assert captured["argv"][3] == "HEAD:refs/heads/feature/test"
