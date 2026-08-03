import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.entrypoint import SandboxSupervisor


def _make_supervisor() -> SandboxSupervisor:
    env = {
        "SANDBOX_ID": "sandbox-1",
        "CONTROL_PLANE_URL": "https://control.example",
        "SANDBOX_AUTH_TOKEN": "token-1",
        "OPENCODE_SESSION_ID": "ses_expected",
        "SESSION_CONFIG": json.dumps({"session_id": "session-1"}),
        "REPO_OWNER": "",
        "REPO_NAME": "",
    }
    with patch.dict(os.environ, env, clear=True):
        return SandboxSupervisor()


def _process(returncode: int, stdout: bytes = b"", stderr: bytes = b"") -> MagicMock:
    process = MagicMock(returncode=returncode)
    process.communicate = AsyncMock(return_value=(stdout, stderr))
    return process


@pytest.mark.asyncio
async def test_restores_checkpoint_before_opencode_server_starts(tmp_path: Path) -> None:
    supervisor = _make_supervisor()
    supervisor.context_unavailable_file = tmp_path / "context-unavailable"
    checkpoint = json.dumps(
        {"info": {"id": "ses_expected", "projectID": "source-workspace"}, "messages": []}
    ).encode()
    rebound_checkpoint = json.dumps(
        {
            "info": {"id": "ses_expected", "projectID": "replacement-workspace"},
            "messages": [],
        }
    ).encode()
    missing_export = _process(1)
    imported = _process(0)
    verified = _process(0, stdout=rebound_checkpoint)
    response = MagicMock(
        status_code=200,
        content=checkpoint,
        headers={
            "X-OpenCode-Session-ID": "ses_expected",
            "X-Checkpoint-ID": "cp_latest",
            "X-Checkpoint-Recovery": "restored",
        },
    )
    client = AsyncMock()
    client.get = AsyncMock(return_value=response)
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None

    with (
        patch.dict(os.environ, {"OPENCODE_SESSION_ID": "ses_expected"}, clear=False),
        patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            AsyncMock(side_effect=[missing_export, imported, verified]),
        ) as create_process,
        patch("sandbox_runtime.entrypoint.httpx.AsyncClient", return_value=client),
    ):
        await supervisor._restore_opencode_context(tmp_path, {})

        assert os.environ["OPENCODE_CONTEXT_STATUS"] == "restored"
        assert os.environ["OPENCODE_CHECKPOINT_ID"] == "cp_latest"
        assert not supervisor.context_unavailable_file.exists()

    import_args = create_process.await_args_list[1].args
    assert import_args[:2] == ("opencode", "import")
    assert import_args[-1] == "--pure"
    assert not Path(import_args[2]).exists()


@pytest.mark.parametrize(
    "imported_info",
    [
        {"id": "ses_expected"},
        {"id": "ses_expected", "projectID": None},
        {"id": "ses_expected", "projectID": ""},
    ],
    ids=["missing", "non-string", "empty"],
)
@pytest.mark.asyncio
async def test_rejects_an_import_without_a_valid_project_binding(
    tmp_path: Path, imported_info: dict[str, object]
) -> None:
    supervisor = _make_supervisor()
    supervisor.context_unavailable_file = tmp_path / "context-unavailable"
    checkpoint = json.dumps(
        {"info": {"id": "ses_expected", "projectID": "source-workspace"}, "messages": []}
    ).encode()
    imported_checkpoint = json.dumps({"info": imported_info, "messages": []}).encode()
    response = MagicMock(
        status_code=200,
        content=checkpoint,
        headers={"X-OpenCode-Session-ID": "ses_expected"},
    )
    client = AsyncMock()
    client.get = AsyncMock(return_value=response)
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None

    with (
        patch.dict(os.environ, {"OPENCODE_SESSION_ID": "ses_expected"}, clear=False),
        patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            AsyncMock(
                side_effect=[_process(1), _process(0), _process(0, stdout=imported_checkpoint)]
            ),
        ),
        patch("sandbox_runtime.entrypoint.httpx.AsyncClient", return_value=client),
    ):
        await supervisor._restore_opencode_context(tmp_path, {})

        assert os.environ["OPENCODE_CONTEXT_STATUS"] == "unavailable"


@pytest.mark.asyncio
async def test_rejects_an_import_that_drops_native_conversation_state(tmp_path: Path) -> None:
    supervisor = _make_supervisor()
    supervisor.context_unavailable_file = tmp_path / "context-unavailable"
    checkpoint = json.dumps(
        {
            "info": {"id": "ses_expected", "projectID": "source-workspace"},
            "messages": [{"info": {"id": "msg-1", "role": "assistant"}, "parts": []}],
        }
    ).encode()
    lossy_export = json.dumps(
        {
            "info": {"id": "ses_expected", "projectID": "replacement-workspace"},
            "messages": [],
        }
    ).encode()
    response = MagicMock(
        status_code=200,
        content=checkpoint,
        headers={"X-OpenCode-Session-ID": "ses_expected"},
    )
    client = AsyncMock()
    client.get = AsyncMock(return_value=response)
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None

    with (
        patch.dict(os.environ, {"OPENCODE_SESSION_ID": "ses_expected"}, clear=False),
        patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            AsyncMock(side_effect=[_process(1), _process(0), _process(0, stdout=lossy_export)]),
        ),
        patch("sandbox_runtime.entrypoint.httpx.AsyncClient", return_value=client),
    ):
        await supervisor._restore_opencode_context(tmp_path, {})

        assert os.environ["OPENCODE_CONTEXT_STATUS"] == "unavailable"

    with (
        patch.dict(os.environ, {"OPENCODE_SESSION_ID": "ses_expected"}, clear=False),
        patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            AsyncMock(),
        ) as create_process,
    ):
        await supervisor._restore_opencode_context(tmp_path, {})

    create_process.assert_not_awaited()


@pytest.mark.asyncio
async def test_falls_back_when_the_newest_checkpoint_import_is_rejected(tmp_path: Path) -> None:
    supervisor = _make_supervisor()
    supervisor.context_unavailable_file = tmp_path / "context-unavailable"
    latest = json.dumps(
        {"info": {"id": "ses_expected", "projectID": "source-workspace"}, "messages": []}
    ).encode()
    previous = json.dumps(
        {
            "info": {"id": "ses_expected", "projectID": "source-workspace"},
            "messages": [{"info": {"id": "msg-previous"}, "parts": []}],
        }
    ).encode()
    client = AsyncMock()
    client.get = AsyncMock(
        side_effect=[
            MagicMock(
                status_code=200,
                content=latest,
                headers={
                    "X-OpenCode-Session-ID": "ses_expected",
                    "X-Checkpoint-Next-Generation": "1",
                    "X-Checkpoint-ID": "cp_latest",
                    "X-Checkpoint-Recovery": "restored",
                },
            ),
            MagicMock(
                status_code=200,
                content=previous,
                headers={
                    "X-OpenCode-Session-ID": "ses_expected",
                    "X-Checkpoint-ID": "cp_previous",
                    "X-Checkpoint-Recovery": "fallback",
                },
            ),
        ]
    )
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None

    with (
        patch.dict(os.environ, {"OPENCODE_SESSION_ID": "ses_expected"}, clear=False),
        patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            AsyncMock(
                side_effect=[
                    _process(1),
                    _process(1, stderr=b"invalid export"),
                    _process(0),
                    _process(0, stdout=previous),
                ]
            ),
        ),
        patch("sandbox_runtime.entrypoint.httpx.AsyncClient", return_value=client),
    ):
        await supervisor._restore_opencode_context(tmp_path, {})

        assert os.environ["OPENCODE_CONTEXT_STATUS"] == "fallback"
        assert os.environ["OPENCODE_CHECKPOINT_ID"] == "cp_previous"

    assert [call.kwargs["params"] for call in client.get.await_args_list] == [
        {"generation": "0"},
        {"generation": "1"},
    ]


@pytest.mark.asyncio
async def test_falls_back_when_the_newest_checkpoint_fails_verification(tmp_path: Path) -> None:
    supervisor = _make_supervisor()
    supervisor.context_unavailable_file = tmp_path / "context-unavailable"
    latest = json.dumps(
        {
            "info": {"id": "ses_expected", "projectID": "source-workspace"},
            "messages": [{"info": {"id": "msg-latest"}, "parts": []}],
        }
    ).encode()
    previous = json.dumps(
        {
            "info": {"id": "ses_expected", "projectID": "source-workspace"},
            "messages": [{"info": {"id": "msg-previous"}, "parts": []}],
        }
    ).encode()
    lossy_export = json.dumps(
        {"info": {"id": "ses_expected", "projectID": "source-workspace"}, "messages": []}
    ).encode()
    client = AsyncMock()
    client.get = AsyncMock(
        side_effect=[
            MagicMock(
                status_code=200,
                content=latest,
                headers={
                    "X-OpenCode-Session-ID": "ses_expected",
                    "X-Checkpoint-Next-Generation": "1",
                    "X-Checkpoint-ID": "cp_latest",
                    "X-Checkpoint-Recovery": "restored",
                },
            ),
            MagicMock(
                status_code=200,
                content=previous,
                headers={
                    "X-OpenCode-Session-ID": "ses_expected",
                    "X-Checkpoint-ID": "cp_previous",
                    "X-Checkpoint-Recovery": "fallback",
                },
            ),
        ]
    )
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None

    with (
        patch.dict(os.environ, {"OPENCODE_SESSION_ID": "ses_expected"}, clear=False),
        patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            AsyncMock(
                side_effect=[
                    _process(1),
                    _process(0),
                    _process(0, stdout=lossy_export),
                    _process(0),
                    _process(0, stdout=previous),
                ]
            ),
        ),
        patch("sandbox_runtime.entrypoint.httpx.AsyncClient", return_value=client),
    ):
        await supervisor._restore_opencode_context(tmp_path, {})

        assert os.environ["OPENCODE_CONTEXT_STATUS"] == "fallback"
        assert not supervisor.context_unavailable_file.exists()


@pytest.mark.asyncio
async def test_keeps_existing_local_context_without_downloading(tmp_path: Path) -> None:
    supervisor = _make_supervisor()
    supervisor.context_unavailable_file = tmp_path / "context-unavailable"
    checkpoint = json.dumps(
        {"info": {"id": "ses_expected", "projectID": "source-workspace"}, "messages": []}
    ).encode()
    local_export = _process(0, stdout=checkpoint)

    with (
        patch.dict(os.environ, {"OPENCODE_SESSION_ID": "ses_expected"}, clear=False),
        patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            AsyncMock(return_value=local_export),
        ),
        patch("sandbox_runtime.entrypoint.httpx.AsyncClient") as client,
    ):
        await supervisor._restore_opencode_context(tmp_path, {})

        assert os.environ["OPENCODE_CONTEXT_STATUS"] == "existing"
        client.assert_not_called()


@pytest.mark.asyncio
async def test_recovers_local_context_from_the_persisted_session_id(tmp_path: Path) -> None:
    supervisor = _make_supervisor()
    supervisor.session_id_file = tmp_path / "opencode-session-id"
    supervisor.session_id_file.write_text("ses_expected")
    supervisor.context_unavailable_file = tmp_path / "context-unavailable"
    checkpoint = json.dumps(
        {"info": {"id": "ses_expected", "projectID": "source-workspace"}, "messages": []}
    ).encode()

    with (
        patch.dict(os.environ, {"OPENCODE_SESSION_ID": ""}, clear=False),
        patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            AsyncMock(return_value=_process(0, stdout=checkpoint)),
        ),
        patch("sandbox_runtime.entrypoint.httpx.AsyncClient") as client,
    ):
        await supervisor._restore_opencode_context(tmp_path, {})
        context_status = os.environ["OPENCODE_CONTEXT_STATUS"]

    assert context_status == "existing"
    client.assert_not_called()


@pytest.mark.asyncio
async def test_retries_checkpoint_download_after_a_transient_failure(tmp_path: Path) -> None:
    supervisor = _make_supervisor()
    supervisor.context_unavailable_file = tmp_path / "context-unavailable"
    checkpoint = json.dumps(
        {"info": {"id": "ses_expected", "projectID": "source-workspace"}, "messages": []}
    ).encode()
    unavailable = MagicMock(status_code=429, content=b"", headers={})
    available = MagicMock(
        status_code=200,
        content=checkpoint,
        headers={"X-OpenCode-Session-ID": "ses_expected"},
    )
    client = AsyncMock()
    client.get = AsyncMock(side_effect=[unavailable, available])
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None
    with (
        patch.dict(os.environ, {"OPENCODE_SESSION_ID": "ses_expected"}, clear=False),
        patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            AsyncMock(side_effect=[_process(1), _process(0), _process(0, stdout=checkpoint)]),
        ),
        patch("sandbox_runtime.entrypoint.httpx.AsyncClient", return_value=client),
        patch("sandbox_runtime.entrypoint.asyncio.sleep", new_callable=AsyncMock),
    ):
        await supervisor._restore_opencode_context(tmp_path, {})
        restored_context_status = os.environ["OPENCODE_CONTEXT_STATUS"]

    assert restored_context_status == "restored"
    assert client.get.await_count == 2


@pytest.mark.asyncio
async def test_marks_context_unavailable_when_no_checkpoint_exists(tmp_path: Path) -> None:
    supervisor = _make_supervisor()
    supervisor.context_unavailable_file = tmp_path / "context-unavailable"
    response = MagicMock(status_code=404, content=b"", headers={})
    client = AsyncMock()
    client.get = AsyncMock(return_value=response)
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None

    with (
        patch.dict(os.environ, {"OPENCODE_SESSION_ID": "ses_expected"}, clear=False),
        patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            AsyncMock(return_value=_process(1)),
        ),
        patch("sandbox_runtime.entrypoint.httpx.AsyncClient", return_value=client),
    ):
        await supervisor._restore_opencode_context(tmp_path, {})

        assert os.environ["OPENCODE_CONTEXT_STATUS"] == "unavailable"
