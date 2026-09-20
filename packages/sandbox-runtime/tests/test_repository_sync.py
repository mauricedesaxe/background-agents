import asyncio
import json
import signal
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.repo_config import RepoEntry
from sandbox_runtime.repository_sync import (
    DEFAULT_GIT_CLONE_TIMEOUT_SECONDS,
    DEFAULT_GIT_FETCH_TIMEOUT_SECONDS,
    GIT_DIAGNOSTIC_MAX_CHARS,
    GIT_SYNC_REPORT_MAX_BYTES,
    GIT_SYNC_REPORT_MAX_REPOSITORIES,
    GitOperationResult,
    RepositorySynchronizer,
    RepositorySyncOperation,
    RepositorySyncOutcome,
    RepositorySyncResult,
    RepositorySyncStatus,
)
from sandbox_runtime.runtime_config import BootMode


def _repository(tmp_path: Path, name: str = "app") -> RepoEntry:
    return RepoEntry(owner="acme", name=name, branch="main", path=tmp_path / name)


def _hung_process() -> MagicMock:
    async def communicate_forever() -> tuple[bytes, bytes]:
        await asyncio.Event().wait()
        return b"", b""

    process = MagicMock(returncode=None, pid=4321)
    process.communicate = AsyncMock(side_effect=communicate_forever)
    process.wait = AsyncMock(return_value=-signal.SIGKILL)
    return process


def test_git_operation_timeout_defaults_are_named() -> None:
    synchronizer = RepositorySynchronizer("github.com", MagicMock())

    assert synchronizer.clone_timeout_seconds == DEFAULT_GIT_CLONE_TIMEOUT_SECONDS
    assert synchronizer.fetch_timeout_seconds == DEFAULT_GIT_FETCH_TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_hung_clone_times_out_and_cleans_up_process_group(tmp_path: Path) -> None:
    process = _hung_process()
    log = MagicMock()
    synchronizer = RepositorySynchronizer("github.com", log, clone_timeout_seconds=0.01)
    repo = _repository(tmp_path)

    with (
        patch(
            "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            return_value=process,
        ) as create_process,
        patch("sandbox_runtime.repository_sync.os.killpg") as kill_process_group,
    ):
        result = await synchronizer._clone_repo(repo)

    assert result.status is RepositorySyncStatus.TIMED_OUT
    kill_process_group.assert_called_once_with(process.pid, signal.SIGKILL)
    process.wait.assert_awaited_once()
    assert create_process.await_args.kwargs["start_new_session"] is True
    log.error.assert_called_once_with(
        "git.clone_timeout",
        repo_owner="acme",
        repo_name="app",
        timeout_seconds=0.01,
    )


@pytest.mark.asyncio
async def test_hung_fetch_times_out_and_cleans_up_process_group(tmp_path: Path) -> None:
    process = _hung_process()
    log = MagicMock()
    synchronizer = RepositorySynchronizer("github.com", log, fetch_timeout_seconds=0.01)
    repo = _repository(tmp_path)
    repo.path.mkdir()

    with (
        patch(
            "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            return_value=process,
        ) as create_process,
        patch("sandbox_runtime.repository_sync.os.killpg") as kill_process_group,
    ):
        result = await synchronizer._fetch_branch(repo, repo.branch)

    assert result.status is RepositorySyncStatus.TIMED_OUT
    kill_process_group.assert_called_once_with(process.pid, signal.SIGKILL)
    process.wait.assert_awaited_once()
    assert create_process.await_args.kwargs["start_new_session"] is True
    log.error.assert_called_once_with(
        "git.fetch_timeout",
        repo_owner="acme",
        repo_name="app",
        timeout_seconds=0.01,
    )


@pytest.mark.asyncio
async def test_multi_repository_sync_identifies_timed_out_member(tmp_path: Path) -> None:
    repositories = [_repository(tmp_path, "frontend"), _repository(tmp_path, "backend")]
    synchronizer = RepositorySynchronizer("github.com", MagicMock())

    async def sync_repo(repo: RepoEntry, _boot_mode: BootMode) -> GitOperationResult:
        if repo.name == "backend":
            return GitOperationResult(RepositorySyncStatus.TIMED_OUT, "fetch timed out")
        return GitOperationResult(RepositorySyncStatus.SUCCEEDED)

    synchronizer._sync_repo = AsyncMock(side_effect=sync_repo)

    result = await synchronizer.sync(repositories, BootMode.FRESH)

    assert result.outcomes == (
        RepositorySyncOutcome(
            repositories[0], RepositorySyncStatus.SUCCEEDED, RepositorySyncOperation.CLONE
        ),
        RepositorySyncOutcome(
            repositories[1],
            RepositorySyncStatus.TIMED_OUT,
            RepositorySyncOperation.CLONE,
            "fetch timed out",
        ),
    )
    assert result.failures == (repositories[1],)
    assert result.timed_out == (repositories[1],)
    assert synchronizer._sync_repo.await_count == 2


def test_git_diagnostics_are_redacted_and_bounded() -> None:
    synchronizer = RepositorySynchronizer("github.com", MagicMock())
    secret = "ghp_abcdefghijklmnopqrstuvwxyz"

    diagnostic = synchronizer._sanitize_git_diagnostic(
        (
            "x" * 1200
            + f"\nhttps://user:password@github.com/acme/app?client_secret=query-secret {secret}\n"
            + "Authorization: token github_pat_11AA_secret Authorization=plain-secret"
        ).encode()
    )

    assert "password" not in diagnostic
    assert secret not in diagnostic
    assert "query-secret" not in diagnostic
    assert "github_pat_11AA_secret" not in diagnostic
    assert "plain-secret" not in diagnostic
    assert "https://***@github.com/acme/app?client_secret=***" in diagnostic
    assert "Authorization: *** Authorization=***" in diagnostic
    assert len(diagnostic) == GIT_DIAGNOSTIC_MAX_CHARS


def test_gitlab_and_assignment_credentials_are_redacted_without_corrupting_prose() -> None:
    synchronizer = RepositorySynchronizer("gitlab.com", MagicMock())

    diagnostic = synchronizer._sanitize_git_diagnostic(
        "GitLab glpat-super-secret PRIVATE-TOKEN: header-secret "
        "ACCESS_TOKEN=token-secret password='password secret' api-key=key-secret. "
        "The token is invalid and the password reset failed."
    )

    assert "glpat-super-secret" not in diagnostic
    assert "header-secret" not in diagnostic
    assert "token-secret" not in diagnostic
    assert "password secret" not in diagnostic
    assert "key-secret" not in diagnostic
    assert "PRIVATE-TOKEN: ***" in diagnostic
    assert "ACCESS_TOKEN=***" in diagnostic
    assert "password=***" in diagnostic
    assert "api-key=***" in diagnostic
    assert "The token is invalid and the password reset failed." in diagnostic


@pytest.mark.asyncio
async def test_concurrent_failures_keep_diagnostic_and_exit_code_with_their_repository(
    tmp_path: Path,
) -> None:
    repositories = [_repository(tmp_path, "frontend"), _repository(tmp_path, "backend")]
    synchronizer = RepositorySynchronizer("github.com", MagicMock())

    async def sync_repo(repo: RepoEntry, _boot_mode: BootMode) -> GitOperationResult:
        await asyncio.sleep(0 if repo.name == "backend" else 0.01)
        return GitOperationResult(
            RepositorySyncStatus.FAILED,
            f"{repo.name} failed",
            10 if repo.name == "frontend" else 20,
        )

    synchronizer._sync_repo = AsyncMock(side_effect=sync_repo)

    report = (await synchronizer.sync(repositories, BootMode.FRESH)).report()

    assert report["repositories"] == [
        {
            "repoOwner": "acme",
            "repoName": "frontend",
            "operation": "clone",
            "status": "failed",
            "diagnostic": "frontend failed",
            "exitCode": 10,
        },
        {
            "repoOwner": "acme",
            "repoName": "backend",
            "operation": "clone",
            "status": "failed",
            "diagnostic": "backend failed",
            "exitCode": 20,
        },
    ]


def test_report_enforces_total_byte_budget() -> None:
    repository = RepoEntry(owner="o" * 300, name="n" * 200, branch="main", path=Path("/tmp/repo"))
    result = RepositorySyncOutcome(
        repository,
        RepositorySyncStatus.FAILED,
        RepositorySyncOperation.CLONE,
        "x" * (GIT_DIAGNOSTIC_MAX_CHARS + 100),
        128,
    )

    report = RepositorySyncResult((repository,), tuple(result for _ in range(100))).report()

    assert len(json.dumps(report, separators=(",", ":")).encode()) <= GIT_SYNC_REPORT_MAX_BYTES
    assert len(report["repositories"]) == GIT_SYNC_REPORT_MAX_REPOSITORIES
    assert all(
        len(entry.get("diagnostic", "")) <= GIT_DIAGNOSTIC_MAX_CHARS
        for entry in report["repositories"]
    )


def test_exception_diagnostics_use_the_same_sanitizer() -> None:
    synchronizer = RepositorySynchronizer("github.com", MagicMock())

    result = synchronizer._failed_operation(
        "request failed with Authorization: Bearer ghp_exceptionsecret"
    )

    assert result.diagnostic == "request failed with Authorization: ***"
