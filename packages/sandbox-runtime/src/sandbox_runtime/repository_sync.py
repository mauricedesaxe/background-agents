from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .diagnostics import OPERATOR_DIAGNOSTIC_MAX_CHARS, sanitize_diagnostic_text
from .diff_baseline import resolve_session_diff_baselines
from .process_output import communicate_owned_subprocess, terminate_owned_subprocess

if TYPE_CHECKING:
    from .repo_config import RepoEntry
    from .runtime_config import BootMode

GH_WRAPPER_REAL_PATH = "/usr/bin/gh"
GH_WRAPPER_INSTALL_PATH = Path("/usr/local/bin/gh")
GH_WRAPPER_BODY = Path(__file__).with_name("gh-wrapper.sh").read_text()
DEFAULT_GIT_CLONE_TIMEOUT_SECONDS = 300.0
DEFAULT_GIT_FETCH_TIMEOUT_SECONDS = 120.0
GIT_DIAGNOSTIC_MAX_CHARS = OPERATOR_DIAGNOSTIC_MAX_CHARS
GIT_SYNC_REPORT_MAX_BYTES = 8 * 1024
GIT_SYNC_REPORT_MAX_REPOSITORIES = 10
GIT_SYNC_REPO_OWNER_MAX_CHARS = 300
GIT_SYNC_REPO_NAME_MAX_CHARS = 200


class RepositorySyncStatus(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    TIMED_OUT = "timed_out"


class RepositorySyncOperation(StrEnum):
    CLONE = "clone"
    REFRESH = "refresh"


@dataclass(frozen=True)
class RepositorySyncOutcome:
    repository: RepoEntry
    status: RepositorySyncStatus
    operation: RepositorySyncOperation = RepositorySyncOperation.REFRESH
    diagnostic: str | None = None
    exit_code: int | None = None


@dataclass(frozen=True)
class GitOperationResult:
    status: RepositorySyncStatus
    diagnostic: str | None = None
    exit_code: int | None = None


@dataclass(frozen=True)
class RepositorySyncResult:
    repositories: tuple[RepoEntry, ...]
    outcomes: tuple[RepositorySyncOutcome, ...]

    @property
    def failures(self) -> tuple[RepoEntry, ...]:
        return tuple(
            outcome.repository
            for outcome in self.outcomes
            if outcome.status is not RepositorySyncStatus.SUCCEEDED
        )

    @property
    def non_timeout_failures(self) -> tuple[RepoEntry, ...]:
        return tuple(
            outcome.repository
            for outcome in self.outcomes
            if outcome.status is RepositorySyncStatus.FAILED
        )

    @property
    def timed_out(self) -> tuple[RepoEntry, ...]:
        return tuple(
            outcome.repository
            for outcome in self.outcomes
            if outcome.status is RepositorySyncStatus.TIMED_OUT
        )

    def report(self) -> dict[str, Any]:
        report = {
            "status": "failed" if self.failures else "succeeded",
            "repositories": [
                {
                    "repoOwner": outcome.repository.owner[:GIT_SYNC_REPO_OWNER_MAX_CHARS],
                    "repoName": outcome.repository.name[:GIT_SYNC_REPO_NAME_MAX_CHARS],
                    "operation": outcome.operation.value,
                    "status": outcome.status.value,
                    **(
                        {"diagnostic": outcome.diagnostic[-GIT_DIAGNOSTIC_MAX_CHARS:]}
                        if outcome.diagnostic
                        else {}
                    ),
                    **({"exitCode": outcome.exit_code} if outcome.exit_code is not None else {}),
                }
                for outcome in self.outcomes[:GIT_SYNC_REPORT_MAX_REPOSITORIES]
            ],
        }
        while len(json.dumps(report, separators=(",", ":")).encode()) > GIT_SYNC_REPORT_MAX_BYTES:
            entries_with_diagnostics = [
                entry
                for entry in report["repositories"]
                if isinstance(entry.get("diagnostic"), str) and entry["diagnostic"]
            ]
            if not entries_with_diagnostics:
                raise ValueError("Git sync report identity data exceeds byte budget")
            entry = max(entries_with_diagnostics, key=lambda item: len(item["diagnostic"]))
            excess = (
                len(json.dumps(report, separators=(",", ":")).encode()) - GIT_SYNC_REPORT_MAX_BYTES
            )
            diagnostic = entry["diagnostic"]
            entry["diagnostic"] = diagnostic[: max(0, len(diagnostic) - max(excess, 16))]
            if not entry["diagnostic"]:
                del entry["diagnostic"]
        return report


class RepositorySynchronizer:
    CLONE_DEPTH_COMMITS = 100

    def __init__(
        self,
        vcs_host: str,
        log: Any,
        *,
        clone_timeout_seconds: float = DEFAULT_GIT_CLONE_TIMEOUT_SECONDS,
        fetch_timeout_seconds: float = DEFAULT_GIT_FETCH_TIMEOUT_SECONDS,
    ) -> None:
        self.vcs_host = vcs_host
        self.log = log
        self.clone_timeout_seconds = clone_timeout_seconds
        self.fetch_timeout_seconds = fetch_timeout_seconds

    def _build_repo_url(self, repo: RepoEntry) -> str:
        return f"https://{self.vcs_host}/{repo.owner}/{repo.name}.git"

    def _sanitize_git_diagnostic(self, value: bytes | str) -> str:
        return sanitize_diagnostic_text(value)[-GIT_DIAGNOSTIC_MAX_CHARS:]

    def _failed_operation(
        self, diagnostic: bytes | str, exit_code: int | None = None
    ) -> GitOperationResult:
        return GitOperationResult(
            RepositorySyncStatus.FAILED,
            self._sanitize_git_diagnostic(diagnostic) or None,
            exit_code,
        )

    async def _terminate_owned_subprocess(self, process: asyncio.subprocess.Process) -> None:
        await terminate_owned_subprocess(process, kill_process_group=os.killpg)

    async def _communicate_owned_subprocess(
        self, process: asyncio.subprocess.Process
    ) -> tuple[bytes, bytes]:
        return await communicate_owned_subprocess(process, kill_process_group=os.killpg)

    async def _clone_repo(self, repo: RepoEntry) -> GitOperationResult:
        self.log.info("git.clone_start", repo_owner=repo.owner, repo_name=repo.name)
        try:
            result = await asyncio.create_subprocess_exec(
                "git",
                "clone",
                "--depth",
                str(self.CLONE_DEPTH_COMMITS),
                "--branch",
                repo.branch,
                self._build_repo_url(repo),
                str(repo.path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            _stdout, stderr = await asyncio.wait_for(
                self._communicate_owned_subprocess(result),
                timeout=self.clone_timeout_seconds,
            )
        except TimeoutError:
            self.log.error(
                "git.clone_timeout",
                repo_owner=repo.owner,
                repo_name=repo.name,
                timeout_seconds=self.clone_timeout_seconds,
            )
            return GitOperationResult(
                RepositorySyncStatus.TIMED_OUT,
                self._sanitize_git_diagnostic(
                    f"git clone timed out after {self.clone_timeout_seconds:g} seconds"
                ),
            )
        except Exception as error:
            self.log.error("git.clone_error", exc=error, repo_owner=repo.owner, repo_name=repo.name)
            return self._failed_operation(str(error))
        if result.returncode != 0:
            operation_result = self._failed_operation(stderr, result.returncode)
            self.log.error(
                "git.clone_error",
                repo_owner=repo.owner,
                repo_name=repo.name,
                stderr=operation_result.diagnostic,
                exit_code=result.returncode,
            )
            return operation_result
        self.log.info("git.clone_complete", repo_path=str(repo.path))
        return GitOperationResult(RepositorySyncStatus.SUCCEEDED)

    async def ensure_credentials_configured(self) -> None:
        shim_path = Path("/usr/local/bin/oi-git-credentials")
        shim_body = (
            '#!/bin/sh\nexec python3 -m sandbox_runtime.credentials.git_credential_helper "$@"\n'
        )
        shim_available = False
        try:
            if shim_path.exists() and shim_path.read_text() == shim_body:
                shim_available = True
            else:
                shim_path.write_text(shim_body)
                shim_path.chmod(0o755)
                shim_available = True
        except OSError as error:
            self.log.warn("credential_helper.shim_write_failed", error=str(error))
        configs = [("credential.useHttpPath", "true")]
        if shim_available:
            configs.insert(0, ("credential.helper", str(shim_path)))
        for key, value in configs:
            process = await asyncio.create_subprocess_exec(
                "git",
                "config",
                "--global",
                "--replace-all",
                key,
                value,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            _stdout, stderr = await self._communicate_owned_subprocess(process)
            if process.returncode != 0:
                self.log.warn(
                    "credential_helper.config_failed",
                    config_key=key,
                    exit_code=process.returncode,
                    stderr=stderr.decode(errors="replace"),
                )
        self._install_gh_wrapper()

    def _install_gh_wrapper(self) -> None:
        real_path = Path(GH_WRAPPER_REAL_PATH)
        if not os.access(real_path, os.X_OK):
            return
        try:
            if (
                GH_WRAPPER_INSTALL_PATH.exists()
                and GH_WRAPPER_INSTALL_PATH.read_text() == GH_WRAPPER_BODY
                and os.access(GH_WRAPPER_INSTALL_PATH, os.X_OK)
            ):
                return
            GH_WRAPPER_INSTALL_PATH.write_text(GH_WRAPPER_BODY)
            GH_WRAPPER_INSTALL_PATH.chmod(0o755)
        except OSError as error:
            raise RuntimeError(
                f"Cannot install authenticated gh wrapper at {GH_WRAPPER_INSTALL_PATH}: {error}"
            ) from error

    async def _ensure_plain_origin(self, repo: RepoEntry) -> GitOperationResult:
        process = await asyncio.create_subprocess_exec(
            "git",
            "remote",
            "set-url",
            "origin",
            self._build_repo_url(repo),
            cwd=repo.path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        _stdout, stderr = await self._communicate_owned_subprocess(process)
        if process.returncode != 0:
            operation_result = self._failed_operation(stderr, process.returncode)
            self.log.error(
                "git.set_url_failed",
                exit_code=process.returncode,
                stderr=operation_result.diagnostic,
            )
            return operation_result
        return GitOperationResult(RepositorySyncStatus.SUCCEEDED)

    async def _fetch_branch(self, repo: RepoEntry, branch: str) -> GitOperationResult:
        process = await asyncio.create_subprocess_exec(
            "git",
            "fetch",
            "origin",
            f"{branch}:refs/remotes/origin/{branch}",
            cwd=repo.path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        try:
            _stdout, stderr = await asyncio.wait_for(
                self._communicate_owned_subprocess(process),
                timeout=self.fetch_timeout_seconds,
            )
        except TimeoutError:
            self.log.error(
                "git.fetch_timeout",
                repo_owner=repo.owner,
                repo_name=repo.name,
                timeout_seconds=self.fetch_timeout_seconds,
            )
            return GitOperationResult(
                RepositorySyncStatus.TIMED_OUT,
                self._sanitize_git_diagnostic(
                    f"git fetch timed out after {self.fetch_timeout_seconds:g} seconds"
                ),
            )
        if process.returncode != 0:
            operation_result = self._failed_operation(stderr, process.returncode)
            self.log.error(
                "git.fetch_error",
                stderr=operation_result.diagnostic,
                exit_code=process.returncode,
            )
            return operation_result
        return GitOperationResult(RepositorySyncStatus.SUCCEEDED)

    async def _checkout_branch(self, repo: RepoEntry, branch: str) -> GitOperationResult:
        process = await asyncio.create_subprocess_exec(
            "git",
            "checkout",
            "-B",
            branch,
            f"origin/{branch}",
            cwd=repo.path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        _stdout, stderr = await self._communicate_owned_subprocess(process)
        if process.returncode != 0:
            operation_result = self._failed_operation(stderr, process.returncode)
            self.log.warn(
                "git.checkout_error",
                stderr=operation_result.diagnostic,
                exit_code=process.returncode,
                target_branch=branch,
            )
            return operation_result
        return GitOperationResult(RepositorySyncStatus.SUCCEEDED)

    async def _update_existing_repo(
        self, repo: RepoEntry, boot_mode: BootMode
    ) -> GitOperationResult:
        if not repo.path.exists():
            self.log.info(
                "git.update_skip",
                reason="no_repo_path",
                repo_owner=repo.owner,
                repo_name=repo.name,
            )
            return self._failed_operation("repository path does not exist")
        preserve_checkout = boot_mode.preserves_repository_checkout
        try:
            origin_result = await self._ensure_plain_origin(repo)
            if origin_result.status is not RepositorySyncStatus.SUCCEEDED:
                return origin_result
            fetch_result = await self._fetch_branch(repo, repo.branch)
            if fetch_result.status is not RepositorySyncStatus.SUCCEEDED:
                return fetch_result
            if preserve_checkout:
                return GitOperationResult(RepositorySyncStatus.SUCCEEDED)
            return await self._checkout_branch(repo, repo.branch)
        except Exception as error:
            if preserve_checkout:
                self.log.warn(
                    "git.restore_refresh_error",
                    exc=error,
                    repo_owner=repo.owner,
                    repo_name=repo.name,
                )
                return self._failed_operation(str(error))
            self.log.error(
                "git.update_error", exc=error, repo_owner=repo.owner, repo_name=repo.name
            )
            return self._failed_operation(str(error))

    async def _get_head_sha(self, repo: RepoEntry) -> str:
        if not repo.path.exists():
            return ""
        try:
            process = await asyncio.create_subprocess_exec(
                "git",
                "rev-parse",
                "HEAD",
                cwd=repo.path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            stdout, _ = await self._communicate_owned_subprocess(process)
            if process.returncode == 0:
                return stdout.decode().strip()
        except Exception as error:
            self.log.warn("git.rev_parse_error", error=str(error))
        return ""

    async def _sync_repo(self, repo: RepoEntry, boot_mode: BootMode) -> GitOperationResult:
        self.log.debug(
            "git.sync_start",
            repo_owner=repo.owner,
            repo_name=repo.name,
            repo_path=str(repo.path),
        )
        if not repo.path.exists():
            clone_result = await self._clone_repo(repo)
            if clone_result.status is not RepositorySyncStatus.SUCCEEDED:
                return clone_result
        return await self._update_existing_repo(repo, boot_mode)

    async def _sync_repo_status(
        self, repo: RepoEntry, boot_mode: BootMode
    ) -> RepositorySyncOutcome:
        operation = (
            RepositorySyncOperation.REFRESH if repo.path.exists() else RepositorySyncOperation.CLONE
        )
        result = await self._sync_repo(repo, boot_mode)
        return RepositorySyncOutcome(
            repo,
            result.status,
            operation,
            result.diagnostic,
            result.exit_code,
        )

    async def sync(
        self, repositories: list[RepoEntry], boot_mode: BootMode
    ) -> RepositorySyncResult:
        if not repositories:
            self.log.info("git.skip_clone", reason="no_repo_configured")
            return RepositorySyncResult((), ())
        outcomes = await asyncio.gather(
            *(self._sync_repo_status(repo, boot_mode) for repo in repositories)
        )
        resolved = await resolve_session_diff_baselines(
            repositories,
            discover_missing=not boot_mode.preserves_repository_checkout,
            get_head_sha=self._get_head_sha,
        )
        return RepositorySyncResult(tuple(resolved), tuple(outcomes))
