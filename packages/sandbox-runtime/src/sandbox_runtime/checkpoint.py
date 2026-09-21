"""Strict adapter for the lazar-checkpoint process boundary."""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from .process_output import terminate_owned_subprocess

if TYPE_CHECKING:
    from pathlib import Path

    from .repo_config import RepoEntry

CHECKPOINT_TIMEOUT_SECONDS = 120
BEADS_BASELINE_TIMEOUT_SECONDS = 30
_SAFE_CHECKPOINT_ID = re.compile(r"^[A-Za-z0-9._-]+$")
_GIT_OID = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")
_BEADS_STATUS_FIELDS = {"branch", "commit", "schema_version"}

BeadsAuthority = Literal["off", "readonly", "writer"]


class CheckpointError(RuntimeError):
    def __init__(self, message: str, receipt: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.receipt = receipt


@dataclass(frozen=True)
class BeadsBaseline:
    repository_path: Path
    branch: str
    commit: str


def _is_safe_beads_branch(value: object) -> bool:
    return (
        isinstance(value, str)
        and not value.startswith("-")
        and _is_safe_beads_text(value, max_bytes=255)
    )


def _is_safe_checkpoint_id(value: str) -> bool:
    return bool(
        _SAFE_CHECKPOINT_ID.fullmatch(value)
        and value not in (".", "..")
        and not value.startswith(".")
        and not value.endswith(".")
        and not value.endswith(".lock")
        and ".." not in value
    )


def _is_safe_beads_commit(value: object) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 128 and value.isascii() and value.isalnum()


def _is_safe_beads_text(value: str, *, max_bytes: int) -> bool:
    if not value or len(value) > max_bytes or not value.isascii():
        return False
    return all(character == " " or character.isprintable() for character in value)


async def capture_beads_baseline(
    repositories: list[RepoEntry],
    authority: BeadsAuthority,
    *,
    executable: str = "bd",
    timeout_seconds: float = BEADS_BASELINE_TIMEOUT_SECONDS,
) -> BeadsBaseline | None:
    if authority == "off":
        return None
    if authority not in ("readonly", "writer"):
        raise CheckpointError("invalid Beads authority")

    graph_paths: list[Path] = []
    for repository in repositories:
        metadata_path = repository.path / ".beads" / "metadata.json"
        try:
            metadata_bytes = metadata_path.read_bytes()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise CheckpointError("Beads metadata is unavailable") from error
        try:
            metadata = json.loads(metadata_bytes)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise CheckpointError("Beads metadata is malformed") from error
        if not isinstance(metadata, dict) or metadata.get("backend") != "dolt":
            raise CheckpointError("Beads metadata must use the Dolt backend")
        try:
            graph_paths.append(repository.path.resolve(strict=True))
        except OSError as error:
            raise CheckpointError("Beads repository is unavailable") from error

    if not graph_paths:
        return None
    if len(graph_paths) > 1:
        raise CheckpointError("multiple Beads graphs are not supported")
    repository_path = graph_paths[0]

    try:
        process = await asyncio.create_subprocess_exec(
            executable,
            "-C",
            str(repository_path),
            "--readonly",
            "vc",
            "status",
            "--json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
    except OSError as error:
        raise CheckpointError("Beads status command failed") from error
    try:
        stdout, _stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
    except TimeoutError as error:
        await terminate_owned_subprocess(process)
        raise CheckpointError("Beads status command timed out") from error
    except asyncio.CancelledError:
        await terminate_owned_subprocess(process)
        raise
    except Exception as error:
        await terminate_owned_subprocess(process)
        raise CheckpointError("Beads status command failed") from error
    if process.returncode != 0:
        raise CheckpointError("Beads status command failed")

    try:
        status = json.loads(stdout)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise CheckpointError("Beads status is malformed") from error
    if (
        not isinstance(status, dict)
        or set(status) != _BEADS_STATUS_FIELDS
        or type(status.get("schema_version")) is not int
        or status["schema_version"] != 1
        or not _is_safe_beads_branch(status.get("branch"))
        or not _is_safe_beads_commit(status.get("commit"))
    ):
        raise CheckpointError("Beads status is malformed")
    return BeadsBaseline(repository_path, status["branch"], status["commit"])


def build_checkpoint_request(
    *,
    checkpoint_id: str,
    vcs_host: str,
    repositories: list[RepoEntry],
    authority: BeadsAuthority,
    baseline: BeadsBaseline | None,
) -> dict[str, Any]:
    if not _is_safe_checkpoint_id(checkpoint_id):
        raise CheckpointError("checkpoint ID contains unsafe characters")
    if not repositories:
        raise CheckpointError("checkpoint requires at least one repository")
    if not vcs_host or any(character.isspace() for character in vcs_host):
        raise CheckpointError("checkpoint requires a valid VCS host")
    if authority not in ("off", "readonly", "writer"):
        raise CheckpointError("invalid Beads authority")
    if authority == "off" and baseline is not None:
        raise CheckpointError("Beads authority is off but a baseline was provided")

    encoded_repositories = []
    for repository in repositories:
        if not repository.base_sha or not _GIT_OID.fullmatch(repository.base_sha):
            raise CheckpointError(
                f"checkpoint base is unavailable for {repository.owner}/{repository.name}"
            )
        try:
            path = repository.path.resolve(strict=True)
        except OSError as error:
            raise CheckpointError(
                f"checkpoint repository is unavailable: {repository.owner}/{repository.name}"
            ) from error
        encoded_repositories.append(
            {
                "identity": {
                    "host": vcs_host,
                    "owner": repository.owner,
                    "name": repository.name,
                },
                "path": str(path),
                "remote": {"type": "identity", "name": "origin"},
                "baseOid": repository.base_sha.lower(),
                "lease": {"type": "expectedAbsent"},
            }
        )

    beads: dict[str, Any] = {"type": "off"}
    if baseline is not None:
        beads = {
            "type": authority,
            "repositoryPath": str(baseline.repository_path),
            "expectedBranch": baseline.branch,
            "expectedCommit": baseline.commit,
        }
        if authority == "writer":
            commit_message = f"Open Inspect checkpoint {checkpoint_id}"
            if not _is_safe_beads_text(commit_message, max_bytes=1024):
                raise CheckpointError("checkpoint ID is too long for a Beads commit message")
            beads["commitMessage"] = commit_message

    return {
        "schemaVersion": 1,
        "checkpointId": checkpoint_id,
        "repositories": encoded_repositories,
        "beads": beads,
    }


async def run_checkpoint(
    request: dict[str, Any],
    *,
    executable: str = "lazar-checkpoint",
    timeout_seconds: float = CHECKPOINT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    process = await asyncio.create_subprocess_exec(
        executable,
        "checkpoint",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, _stderr = await asyncio.wait_for(
            process.communicate(json.dumps(request, separators=(",", ":")).encode()),
            timeout=timeout_seconds,
        )
    except TimeoutError as error:
        await terminate_owned_subprocess(process)
        raise CheckpointError("checkpoint process timed out") from error
    except asyncio.CancelledError:
        await terminate_owned_subprocess(process)
        raise

    try:
        receipt = json.loads(stdout)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise CheckpointError("checkpoint returned an invalid receipt") from error
    if not isinstance(receipt, dict) or receipt.get("schemaVersion") != 1:
        raise CheckpointError("checkpoint returned an unsupported receipt")
    if process.returncode != 0 or receipt.get("status") != "durable":
        raise CheckpointError("checkpoint did not reach durable state", receipt)
    repository_receipts = receipt.get("repositories")
    request_repositories = request.get("repositories")
    if (
        not isinstance(repository_receipts, list)
        or not isinstance(request_repositories, list)
        or len(repository_receipts) != len(request_repositories)
        or any(
            not isinstance(item, dict)
            or not isinstance(item.get("outcome"), dict)
            or item["outcome"].get("status") not in ("unchanged", "verified")
            for item in repository_receipts
        )
    ):
        raise CheckpointError("checkpoint returned incomplete repository receipts")
    beads = receipt.get("beads")
    if not isinstance(beads, dict) or beads.get("status") not in (
        "off",
        "readonly",
        "writerPushed",
    ):
        raise CheckpointError("checkpoint returned an incomplete Beads receipt")
    return receipt
