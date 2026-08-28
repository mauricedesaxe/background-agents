from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.bridge import AgentBridge, OpenCodeContextStatus
from sandbox_runtime.opencode_client import OpenCodeClient
from tests.conftest import MockResponse


def make_bridge(tmp_path, *, expected_session_id=None, responses=None):
    http_client = AsyncMock()
    http_client.get.side_effect = responses or [MockResponse(200)]
    bridge = AgentBridge(
        sandbox_id="sandbox-1",
        session_id="session-1",
        control_plane_url="https://control.example",
        auth_token="token",
        expected_opencode_session_id=expected_session_id,
        opencode_client=OpenCodeClient(
            base_url="http://localhost:4096",
            log=AsyncMock(),
            http_client=http_client,
        ),
    )
    bridge.session_id_file = tmp_path / "opencode-session-id"
    return bridge, http_client


@pytest.mark.asyncio
async def test_first_session_becomes_ready_without_existing_context(tmp_path):
    bridge, http_client = make_bridge(tmp_path)

    await bridge._load_session_id()

    assert bridge._build_ready_event()["contextStatus"] == "fresh"
    assert bridge.opencode_session_id is None
    http_client.get.assert_not_awaited()


@pytest.mark.asyncio
async def test_expected_context_takes_precedence_over_local_file(tmp_path):
    bridge, http_client = make_bridge(tmp_path, expected_session_id="ses-expected")
    bridge.session_id_file.write_text("ses-local")

    await bridge._load_session_id()

    assert bridge.context_status is OpenCodeContextStatus.EXISTING
    assert bridge.opencode_session_id == "ses-expected"
    assert "/session/ses-expected" in http_client.get.await_args.args[0]


@pytest.mark.asyncio
async def test_local_context_is_verified_when_no_expected_id_exists(tmp_path):
    bridge, http_client = make_bridge(tmp_path)
    bridge.session_id_file.write_text("ses-local")

    await bridge._load_session_id()

    assert bridge.context_status is OpenCodeContextStatus.EXISTING
    assert bridge.opencode_session_id == "ses-local"
    assert "/session/ses-local" in http_client.get.await_args.args[0]


@pytest.mark.asyncio
async def test_404_reports_context_unavailable_without_clearing_id(tmp_path):
    bridge, _ = make_bridge(
        tmp_path,
        expected_session_id="ses-lost",
        responses=[MockResponse(404)],
    )

    await bridge._load_session_id()

    assert bridge.context_status is OpenCodeContextStatus.UNAVAILABLE
    assert bridge.opencode_session_id == "ses-lost"
    assert bridge._build_ready_event()["contextStatus"] == "unavailable"


@pytest.mark.asyncio
async def test_unavailable_context_stops_after_one_ready_event(tmp_path, monkeypatch):
    class ConnectionContext:
        async def __aenter__(self):
            return MagicMock(close_code=None)

        async def __aexit__(self, *_args):
            return False

    bridge, _ = make_bridge(tmp_path, expected_session_id="ses-lost")
    bridge.context_status = OpenCodeContextStatus.UNAVAILABLE
    bridge.opencode_session_id = "ses-lost"
    bridge._send_event = AsyncMock()
    bridge.event_forwarder.bind = AsyncMock()
    monkeypatch.setattr(
        "sandbox_runtime.bridge.websockets.connect",
        lambda *_args, **_kwargs: ConnectionContext(),
    )

    await bridge._connect_and_run()

    assert bridge.shutdown_event.is_set()
    bridge._send_event.assert_awaited_once()


@pytest.mark.asyncio
async def test_transient_verification_retries_until_context_exists(tmp_path):
    bridge, http_client = make_bridge(
        tmp_path,
        expected_session_id="ses-existing",
        responses=[MockResponse(503), MockResponse(200)],
    )
    bridge._wait_for_context_retry = AsyncMock(return_value=True)

    await bridge._load_session_id()

    assert bridge.context_status is OpenCodeContextStatus.EXISTING
    assert http_client.get.await_count == 2
    bridge._wait_for_context_retry.assert_awaited_once_with(1.0)


@pytest.mark.asyncio
async def test_newly_created_session_emits_ready_with_persisted_id(tmp_path):
    bridge, _ = make_bridge(tmp_path)
    bridge.opencode_client.create_session = AsyncMock(return_value="ses-created")
    bridge._send_event = AsyncMock()

    await bridge._create_opencode_session()

    assert bridge.session_id_file.read_text() == "ses-created"
    bridge._send_event.assert_awaited_once()
    event = bridge._send_event.await_args.args[0]
    assert event["opencodeSessionId"] == "ses-created"
    assert event["contextStatus"] == "fresh"
