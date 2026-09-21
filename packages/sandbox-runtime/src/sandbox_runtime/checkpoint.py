"""Strict adapter for the lazar-checkpoint process boundary."""

from __future__ import annotations

import asyncio
import json
import re
from typing import TYPE_CHECKING, Any

from .process_output import terminate_owned_subprocess

if TYPE_CHECKING:
    from .repo_config import RepoEntry

CHECKPOINT_TIMEOUT_SECONDS = 120
_SAFE_CHECKPOINT_ID = re.compile(r"^[A-Za-z0-9._-]+$")
_GIT_OID = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")


class CheckpointError(RuntimeError):
    def __init__(self, message: str, receipt: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.receipt = receipt


def build_checkpoint_request(
    *,
    checkpoint_id: str,
    vcs_host: str,
    repositories: list[RepoEntry],
) -> dict[str, Any]:
    if not _SAFE_CHECKPOINT_ID.fullmatch(checkpoint_id):
        raise CheckpointError("checkpoint ID contains unsafe characters")
    if not repositories:
        raise CheckpointError("checkpoint requires at least one repository")
    if not vcs_host or any(character.isspace() for character in vcs_host):
        raise CheckpointError("checkpoint requires a valid VCS host")

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

    return {
        "schemaVersion": 1,
        "checkpointId": checkpoint_id,
        "repositories": encoded_repositories,
        "beads": {"type": "off"},
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
