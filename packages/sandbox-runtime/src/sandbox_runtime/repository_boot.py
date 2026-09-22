from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .constants import (
    BOOT_COMPLETED_FILE_PATH,
    GIT_SYNC_REPORT_FILE_PATH,
    REPO_MANIFEST_FILE_PATH,
)
from .diagnostics import exception_summary
from .repo_config import RepoConfigError, RepoEntry, dump_repo_manifest, parse_repositories
from .repository_sync import RepositorySyncOutcome, RepositorySyncStatus
from .runtime_config import BootMode, RepositoryConfig

GIT_SYNC_FAILURE_MESSAGE_MAX_CHARS = 1000

if TYPE_CHECKING:
    from .boot_warnings import BootWarningSink
    from .repository_hooks import RepositoryHooks
    from .repository_sync import RepositorySynchronizer
    from .tunnel_environment import TunnelEnvironment


@dataclass(frozen=True)
class RepositoryBootResult:
    git_sync_success: bool
    repository_shas: list[dict[str, str]]
    setup_success: bool | None
    start_success: bool | None
    repositories: tuple[RepoEntry, ...]
    workdir: Path
    git_sync_report: dict[str, Any] = field(
        default_factory=lambda: {"status": "succeeded", "repositories": []}
    )


class RepositoryBootError(RuntimeError):
    def __init__(self, message: str, git_sync_report: dict[str, Any]) -> None:
        super().__init__(message)
        self.git_sync_report = git_sync_report


class RepositoryBoot:
    """Coordinate repository boot ordering and fatal-versus-warning policy."""

    def __init__(
        self,
        config: RepositoryConfig,
        log: Any,
        warnings: BootWarningSink,
        tunnel_environment: TunnelEnvironment,
        hooks: RepositoryHooks,
        synchronizer: RepositorySynchronizer,
    ) -> None:
        self.config = config
        self.log = log
        self.warnings = warnings
        self.tunnel_environment = tunnel_environment
        self.hooks = hooks
        self.synchronizer = synchronizer
        self.sandbox_id = config.sandbox_id
        self.repo_owner = config.repo_owner
        self.repo_name = config.repo_name
        self.vcs_host = config.vcs_host
        self.has_repository = config.has_repository
        self.workspace_path = config.workspace_path
        self.repo_path = config.repo_path
        self.repo_config_error: str | None = None
        self.repositories = self._parse_repositories()
        self.is_multi_repo = len(self.repositories) > 1

    @property
    def base_branch(self) -> str:
        return self.config.branch

    def _parse_repositories(self) -> list[RepoEntry]:
        self.repo_config_error = None
        try:
            return parse_repositories(
                {"repositories": self.config.repositories, "base_sha": self.config.base_sha},
                workspace_path=self.workspace_path,
                scalar_owner=self.repo_owner,
                scalar_name=self.repo_name,
                scalar_branch=self.base_branch,
            )
        except RepoConfigError as error:
            self.repo_config_error = str(error)
            return []

    def _opencode_workdir(self) -> Path:
        if (
            len(self.repositories) == 1
            and self.repo_path.exists()
            and (self.repo_path / ".git").exists()
        ):
            return self.repo_path
        return self.workspace_path

    def _write_repo_manifest(self) -> None:
        try:
            Path(REPO_MANIFEST_FILE_PATH).write_text(dump_repo_manifest(self.repositories))
        except Exception as error:
            self.log.warn("supervisor.repo_manifest_write_failed", exc=error)

    def _write_git_sync_report(self, report: dict[str, Any]) -> None:
        path = Path(GIT_SYNC_REPORT_FILE_PATH)
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w") as temporary_file:
                json.dump(report, temporary_file, separators=(",", ":"))
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            temporary_path.replace(path)
        finally:
            temporary_path.unlink(missing_ok=True)

    def _sync_failure_detail(self, outcome: RepositorySyncOutcome) -> str:
        details = []
        if outcome.exit_code is not None:
            details.append(f"exit code {outcome.exit_code}")
        if outcome.diagnostic:
            details.append(outcome.diagnostic)
        return f" ({'; '.join(details)})" if details else ""

    def _mark_boot_completed(self, boot_mode: BootMode) -> None:
        if boot_mode is BootMode.BUILD:
            return
        marker = Path(BOOT_COMPLETED_FILE_PATH)
        if marker.is_file() and marker.read_text().strip():
            return

        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{marker.name}.", dir=marker.parent)
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w") as temporary_file:
                temporary_file.write(f"{boot_mode.value}\n")
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            temporary_path.replace(marker)
        finally:
            temporary_path.unlink(missing_ok=True)

    def _write_workspace_manifest(self) -> None:
        if not self.is_multi_repo:
            return
        primary = self.repositories[0]
        lines = [
            "<!-- Generated by Open-Inspect on every boot. Do not edit. -->",
            "",
            "# Workspace",
            "",
            "This session spans multiple repositories, checked out side by side:",
            "",
            "| Path | Repository | Base branch |",
            "| --- | --- | --- |",
        ]
        lines.extend(
            f"| `./{repo.name}/` | {repo.owner}/{repo.name} | `{repo.branch}` |"
            for repo in self.repositories
        )
        lines.append("")
        working_branch = self.config.working_branch_name.strip()
        if working_branch:
            lines.extend(
                [f"All work happens on the branch `{working_branch}` in every repository.", ""]
            )
        member_docs = [repo for repo in self.repositories if (repo.path / "AGENTS.md").exists()]
        if member_docs:
            lines.extend(
                [
                    "Repository-specific instructions are NOT loaded automatically. "
                    "Read them before working in a repository:",
                    "",
                    *(f"- `./{repo.name}/AGENTS.md`" for repo in member_docs),
                    "",
                ]
            )
        lines.extend(
            [
                "To open a pull request, call the `create-pull-request` tool once per repository "
                f'with changes, passing its `repo` argument (e.g. `repo: "{primary.owner}/{primary.name}"`). '
                "Calling it again from the same branch updates that repository's open pull "
                "request; to open an additional pull request, create a new branch first. "
                "For a stacked pull request, pass the previous pull request's head branch "
                "as `baseBranch`.",
                "",
            ]
        )
        try:
            (self.workspace_path / "AGENTS.md").write_text("\n".join(lines))
            self.log.info("workspace.manifest_written", repo_count=len(self.repositories))
        except Exception as error:
            self.log.warn("workspace.manifest_write_failed", exc=error)

    def prepare_tunnel_environment(self, boot_mode: BootMode) -> list[int]:
        expected_ports = self.tunnel_environment.expected_ports()
        if boot_mode is BootMode.SNAPSHOT_RESTORE or expected_ports:
            self.tunnel_environment.clear_stale_file()
        return expected_ports

    async def boot(
        self, boot_mode: BootMode, expected_tunnel_ports: list[int]
    ) -> RepositoryBootResult:
        if self.repo_config_error:
            raise RuntimeError(f"invalid repository config: {self.repo_config_error}")
        self._write_repo_manifest()
        if self.repositories:
            await self.synchronizer.ensure_credentials_configured()
        sync_result = await self.synchronizer.sync(self.repositories, boot_mode)
        git_sync_report = sync_result.report()
        self._write_git_sync_report(git_sync_report)
        self.repositories = list(sync_result.repositories)
        git_sync_success = not sync_result.failures
        if sync_result.failures:
            if boot_mode in (BootMode.FRESH, BootMode.BUILD):
                messages = [
                    f"git {outcome.operation.value} {outcome.status.value} for "
                    f"{outcome.repository.owner}/{outcome.repository.name}"
                    f"{self._sync_failure_detail(outcome)}"
                    for outcome in sync_result.outcomes
                    if outcome.status is not RepositorySyncStatus.SUCCEEDED
                ]
                raise RepositoryBootError(
                    "; ".join(messages)[:GIT_SYNC_FAILURE_MESSAGE_MAX_CHARS], git_sync_report
                )
            else:
                for outcome in sync_result.outcomes:
                    repo = outcome.repository
                    if outcome.status is RepositorySyncStatus.SUCCEEDED:
                        continue
                    if outcome.status is RepositorySyncStatus.TIMED_OUT:
                        message = (
                            f"Timed out updating {repo.owner}/{repo.name} from origin; "
                            "the checkout may be stale."
                        )
                    else:
                        message = (
                            f"Could not update {repo.owner}/{repo.name} from origin; "
                            "the checkout may be stale."
                        )
                    message += self._sync_failure_detail(outcome)
                    self.warnings.record("sync", message, repo)
        self._write_repo_manifest()

        self._mark_boot_completed(boot_mode)

        repository_shas: list[dict[str, str]] = []
        if boot_mode is BootMode.BUILD and git_sync_success and self.repositories:
            repository_shas = [
                {
                    "repoOwner": repo.owner,
                    "repoName": repo.name,
                    "baseSha": repo.base_sha or "",
                }
                for repo in self.repositories
            ]
            head_sha = repository_shas[0]["baseSha"]
            if head_sha:
                self.log.info(
                    "git.sync_complete", head_sha=head_sha, repository_shas=repository_shas
                )
        setup_success: bool | None = None
        if self.repositories and boot_mode in (BootMode.FRESH, BootMode.BUILD):
            setup_success = True
            for repo in self.repositories:
                try:
                    setup_succeeded = await self.hooks.run_setup(repo, boot_mode)
                except Exception as error:
                    raise RepositoryBootError(exception_summary(error), git_sync_report) from error
                if setup_succeeded:
                    continue
                setup_success = False
                if boot_mode is BootMode.BUILD:
                    raise RepositoryBootError(
                        f"setup hook failed for {repo.owner}/{repo.name} in build mode",
                        git_sync_report,
                    )
                self.warnings.record(
                    "setup",
                    f"setup.sh failed for {repo.owner}/{repo.name}; the session continues without it.",
                    repo,
                )

        start_success: bool | None = None
        if self.repositories and boot_mode is not BootMode.BUILD:
            await self.tunnel_environment.wait_until_ready(expected_tunnel_ports)
            start_success = True
            for index, repo in enumerate(self.repositories):
                try:
                    start_succeeded = await self.hooks.run_start(repo, boot_mode)
                except Exception as error:
                    raise RepositoryBootError(exception_summary(error), git_sync_report) from error
                if start_succeeded:
                    continue
                start_success = False
                if index == 0:
                    raise RepositoryBootError(
                        f"start hook failed for {repo.owner}/{repo.name}", git_sync_report
                    )
                self.warnings.record(
                    "start",
                    f"start.sh failed for {repo.owner}/{repo.name}; the session continues without it.",
                    repo,
                )

        self._write_workspace_manifest()
        return RepositoryBootResult(
            git_sync_success=git_sync_success,
            repository_shas=repository_shas,
            setup_success=setup_success,
            start_success=start_success,
            repositories=tuple(self.repositories),
            workdir=self._opencode_workdir(),
            git_sync_report=git_sync_report,
        )
