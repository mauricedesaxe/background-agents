"""Local Git push execution, independent of control-plane transport."""

import asyncio
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

from .log_config import StructuredLogger
from .process_output import communicate_owned_subprocess
from .repo_config import find_repo_entry, load_repo_manifest

GIT_PUSH_TIMEOUT_SECONDS = 300.0
GIT_PUSH_TERMINATE_GRACE_SECONDS = 5.0
JJ_COMMAND_TIMEOUT_SECONDS = 60.0

JJ_LOCK_ERROR_PATTERN = re.compile(r"lock", re.IGNORECASE)


@dataclass(frozen=True)
class PushRequest:
    """Validated provider-generated push spec, or correlation data for a rejection."""

    branch_name: str
    repo_owner: str
    repo_name: str
    refspec: str
    push_url: str
    redacted_push_url: str
    force: bool

    @classmethod
    def from_push_spec(cls, push_spec: object) -> "PushRequest":
        spec = push_spec if isinstance(push_spec, dict) else {}

        def field(key: str) -> str:
            value = spec.get(key)
            return value.strip() if isinstance(value, str) else ""

        force = spec.get("force")
        request = cls(
            branch_name=field("targetBranch"),
            repo_owner=field("repoOwner"),
            repo_name=field("repoName"),
            refspec=field("refspec"),
            push_url=field("remoteUrl"),
            redacted_push_url=field("redactedRemoteUrl"),
            force=force if isinstance(force, bool) else False,
        )
        error = None
        if not isinstance(push_spec, dict):
            error = "missing push specification"
        elif ("repoOwner" in spec or "repoName" in spec) and not request.has_repo_identity:
            error = "pushSpec must carry both repoOwner and repoName"
        elif not request.branch_name:
            error = "missing target branch"
        elif (
            not request.refspec
            or not request.push_url
            or not request.redacted_push_url
            or not isinstance(force, bool)
        ):
            error = "invalid push specification"
        if error:
            raise PushRejected(f"Push failed - {error}", request)
        return request

    @property
    def has_repo_identity(self) -> bool:
        return bool(self.repo_owner and self.repo_name)

    @property
    def repo_full_name(self) -> str:
        return f"{self.repo_owner}/{self.repo_name}"

    def repo_fields(self) -> dict[str, Any]:
        """Include partial identity too, so rejected requests retain their metadata."""
        fields: dict[str, Any] = {}
        if self.repo_owner:
            fields["repoOwner"] = self.repo_owner
        if self.repo_name:
            fields["repoName"] = self.repo_name
        return fields


@dataclass(frozen=True)
class PushResult:
    request: PushRequest
    error: str | None = None


class PushRejected(Exception):
    """A user-facing rejection with optional parsed correlation metadata."""

    def __init__(self, message: str, request: PushRequest | None = None):
        super().__init__(message)
        self.request = request


class PushOperation:
    def __init__(self, *, repo_path: Path, manifest_path: Path, logger: StructuredLogger):
        self.repo_path = repo_path
        self.manifest_path = manifest_path
        self.log = logger

    async def execute(self, push_spec: object) -> PushResult:
        try:
            request = PushRequest.from_push_spec(push_spec)
        except PushRejected as rejection:
            assert rejection.request is not None
            self.log.warn("git.push_error", reason="invalid_push_spec")
            return PushResult(rejection.request, str(rejection))
        self.log.info(
            "git.push_start",
            branch_name=request.branch_name,
            repo_owner=request.repo_owner,
            repo_name=request.repo_name,
            mode="push_spec",
        )
        try:
            repo_dir = self._resolve_push_checkout(request)
            refspec = await self._resolve_refspec(request, repo_dir)
            await self._run_git_push(request, repo_dir, refspec)
        except PushRejected as rejection:
            return PushResult(request, str(rejection))
        except Exception as e:
            self.log.error("git.push_error", exc=e, branch_name=request.branch_name)
            return PushResult(request, str(e) or "Push failed - unknown error")

        self.log.info(
            "git.push_complete",
            branch_name=request.branch_name,
            repo_owner=request.repo_owner,
            repo_name=request.repo_name,
        )
        return PushResult(request)

    def _reject_push(self, *, reason: str, message: str, **log_fields: Any) -> NoReturn:
        self.log.warn("git.push_error", reason=reason, **log_fields)
        raise PushRejected(message)

    def _resolve_push_checkout(self, request: PushRequest) -> Path:
        if request.has_repo_identity:
            return self._member_checkout(request)
        return self._sole_workspace_checkout()

    async def _resolve_refspec(self, request: PushRequest, repo_dir: Path) -> str:
        """Resolve what the push publishes: the working copy in a jj-colocated
        checkout, the spec's refspec (typically ``HEAD``) otherwise.

        A jj-colocated checkout pins ``.git/HEAD`` to the working-copy commit
        ``@-``, so pushing ``HEAD`` publishes an empty branch. Setting the
        bookmark named after the target branch to ``@`` and pushing that
        bookmark refspec publishes the actual work instead.
        """
        if not (repo_dir / ".jj").exists():
            return request.refspec
        bookmark_refspec = f"{request.branch_name}:refs/heads/{request.branch_name}"
        if await self._pin_jj_bookmark(request, repo_dir):
            return bookmark_refspec
        self.log.warn(
            "git.push_jj_fallback",
            reason="jj_command_failed",
            branch_name=request.branch_name,
        )
        return request.refspec

    async def _pin_jj_bookmark(self, request: PushRequest, repo_dir: Path) -> bool:
        """Point the target branch's bookmark at the working copy.

        False only when the bookmark itself cannot be set — the caller then
        falls back to the spec's refspec. A failed ``git export`` keeps this
        True: in a colocated checkout the ref is auto-exported anyway, and
        when it is genuinely missing the bookmark refspec push fails visibly
        instead of silently publishing the empty branch the fallback would.
        """
        command = (
            "jj",
            "--repository",
            str(repo_dir),
            "bookmark",
            "set",
            "--allow-backwards",
            "--revision",
            "@",
            request.branch_name,
        )
        if not await self._run_jj_command(command, request.branch_name):
            return False
        export = ("jj", "--repository", str(repo_dir), "git", "export")
        if not await self._run_jj_command(export, request.branch_name):
            self.log.warn(
                "git.push_jj_export_failed",
                branch_name=request.branch_name,
            )
        return True

    async def _run_jj_command(self, command: tuple[str, ...], branch_name: str) -> bool:
        process: asyncio.subprocess.Process | None = None
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            _stdout, stderr = await asyncio.wait_for(
                communicate_owned_subprocess(
                    process, terminate_grace_seconds=GIT_PUSH_TERMINATE_GRACE_SECONDS
                ),
                timeout=JJ_COMMAND_TIMEOUT_SECONDS,
            )
        except Exception as e:
            self.log.warn(
                "git.push_jj_command_failed",
                exc=e,
                command=command[1:],
                branch_name=branch_name,
            )
            return False
        if process.returncode != 0:
            stderr_text = stderr.decode("utf-8", errors="replace").strip() if stderr else ""
            self.log.warn(
                "git.push_jj_command_failed",
                command=command[1:],
                branch_name=branch_name,
                stderr=stderr_text,
            )
            if self._is_jj_lock_conflict(stderr_text):
                raise PushRejected(
                    "Push failed - jj workspace is locked by a concurrent jj process; "
                    "not falling back to the raw refspec to avoid publishing stale state"
                )
            return False
        return True

    @staticmethod
    def _is_jj_lock_conflict(stderr_text: str) -> bool:
        """Whether a failed jj command lost its lock to a concurrent jj process.

        Why: the refspec fallback would publish whatever HEAD points at in a
        checkout another jj process is mid-write on, silently publishing stale
        state. A missing binary is the only failure that still falls back.
        """
        return bool(JJ_LOCK_ERROR_PATTERN.search(stderr_text))

    def _member_checkout(self, request: PushRequest) -> Path:
        # Only canonical manifest paths select checkouts, never spec-supplied paths.
        member = find_repo_entry(
            load_repo_manifest(self.manifest_path),
            request.repo_owner,
            request.repo_name,
        )
        if member is None:
            self._reject_push(
                reason="repo_not_session_member",
                message=f"Repository {request.repo_full_name} is not part of this session",
                repo_owner=request.repo_owner,
                repo_name=request.repo_name,
            )
        if not (member.path / ".git").exists():
            self._reject_push(
                reason="repo_not_in_workspace",
                message=f"Repository {request.repo_full_name} not found in workspace",
                repo_owner=request.repo_owner,
                repo_name=request.repo_name,
            )
        return member.path

    def _sole_workspace_checkout(self) -> Path:
        """Legacy identity-free fallback, sorted for deterministic selection."""
        repo_dirs = sorted(self.repo_path.glob("*/.git"))
        if not repo_dirs:
            self._reject_push(reason="no_repo_configured", message="No repository found")
        return repo_dirs[0].parent

    async def _run_git_push(self, request: PushRequest, repo_dir: Path, refspec: str) -> None:
        self.log.info(
            "git.push_command",
            branch_name=request.branch_name,
            refspec=refspec,
            force=request.force,
            remote_url=request.redacted_push_url,
        )
        process = await asyncio.create_subprocess_exec(
            "git",
            "push",
            *(["-f"] if request.force else []),
            "--",
            request.push_url,
            refspec,
            cwd=repo_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        try:
            _stdout, stderr = await asyncio.wait_for(
                communicate_owned_subprocess(
                    process, terminate_grace_seconds=GIT_PUSH_TERMINATE_GRACE_SECONDS
                ),
                timeout=GIT_PUSH_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            self.log.warn(
                "git.push_timeout",
                branch_name=request.branch_name,
                timeout_ms=int(GIT_PUSH_TIMEOUT_SECONDS * 1000),
            )
            raise PushRejected(
                f"Push failed - git push timed out after {int(GIT_PUSH_TIMEOUT_SECONDS)}s"
            ) from None

        if process.returncode != 0:
            stderr_text = stderr.decode("utf-8", errors="replace").strip() if stderr else ""
            redacted_stderr_text = self._redact_git_stderr(
                stderr_text, request.push_url, request.redacted_push_url
            )
            self.log.warn(
                "git.push_failed", branch_name=request.branch_name, stderr=redacted_stderr_text
            )
            raise PushRejected(
                f"Push failed: {redacted_stderr_text}"
                if redacted_stderr_text
                else "Push failed - unknown error"
            )

    @staticmethod
    def _redact_git_stderr(stderr_text: str, push_url: str, redacted_push_url: str) -> str:
        """Redact credential-bearing URLs from git stderr."""
        redacted_stderr = stderr_text
        if push_url and redacted_push_url:
            redacted_stderr = redacted_stderr.replace(push_url, redacted_push_url)
        return re.sub(r"(https?://)([^/\s@]+)@", r"\1***@", redacted_stderr)
