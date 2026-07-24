import asyncio
import contextlib
import json
from collections.abc import AsyncIterator
from typing import Any

import pytest

from sandbox_runtime.bridge import AgentBridge
from tests.conftest import MockResponse


def sse_event(event_type: str, properties: dict[str, Any]) -> str:
    return f"data: {json.dumps({'type': event_type, 'properties': properties})}\n\n"


class MockSSEResponse:
    status_code = 200

    def __init__(self, events: list[str]) -> None:
        self.events = events

    async def aiter_text(self) -> AsyncIterator[str]:
        for event in self.events:
            yield event
            await asyncio.sleep(0)

    async def __aenter__(self) -> "MockSSEResponse":
        return self

    async def __aexit__(self, *args: object) -> None:
        return None


class MockHttpClient:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.posts: list[tuple[str, dict[str, Any] | None]] = []

    def stream(self, method: str, url: str, timeout: object = None) -> MockSSEResponse:
        return MockSSEResponse(self.events)

    async def post(
        self, url: str, json: dict[str, Any] | None = None, timeout: object = None
    ) -> MockResponse:
        self.posts.append((url, json))
        return MockResponse(200, True)


@pytest.fixture
def bridge() -> AgentBridge:
    instance = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    instance.opencode_session_id = "oc-session-123"
    return instance


@pytest.mark.asyncio
async def test_native_compaction_uses_selected_model_and_reports_success(
    bridge: AgentBridge,
) -> None:
    client = MockHttpClient([sse_event("session.compacted", {"sessionID": "oc-session-123"})])
    bridge.http_client = client
    sent: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any]) -> None:
        sent.append(event)

    bridge._send_event = capture  # type: ignore[method-assign]

    await bridge._handle_context_compaction(
        {
            "requestId": "compact-1",
            "model": "openrouter/google/gemini-3.1-pro-preview",
        }
    )

    assert client.posts == [
        (
            "http://localhost:4096/session/oc-session-123/summarize",
            {"providerID": "openrouter", "modelID": "google/gemini-3.1-pro-preview"},
        )
    ]
    assert sent == [{"type": "context_compacted", "requestId": "compact-1"}]


@pytest.mark.asyncio
async def test_native_compaction_reports_summary_usage_before_success(
    bridge: AgentBridge,
) -> None:
    client = MockHttpClient(
        [
            sse_event(
                "message.part.updated",
                {
                    "part": {
                        "id": "part-summary-finish",
                        "sessionID": "oc-session-123",
                        "type": "step-finish",
                        "cost": 0.02,
                        "tokens": {"total": 25, "input": 20, "output": 5},
                        "reason": "stop",
                    }
                },
            ),
            sse_event("session.compacted", {"sessionID": "oc-session-123"}),
        ]
    )
    bridge.http_client = client
    sent: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any]) -> None:
        sent.append(event)

    bridge._send_event = capture  # type: ignore[method-assign]

    await bridge._handle_context_compaction(
        {"requestId": "compact-usage", "model": "openai/gpt-5.6-sol"}
    )

    assert sent == [
        {
            "type": "step_finish",
            "messageId": "compact-usage",
            "stepId": "part-summary-finish",
            "cost": 0.02,
            "tokens": {"total": 25, "input": 20, "output": 5},
            "reason": "stop",
        },
        {"type": "context_compacted", "requestId": "compact-usage"},
    ]


@pytest.mark.asyncio
async def test_prompt_continues_in_same_opencode_session_after_compaction(
    bridge: AgentBridge,
) -> None:
    bridge.http_client = MockHttpClient(
        [sse_event("session.compacted", {"sessionID": "oc-session-123"})]
    )
    sent: list[dict[str, Any]] = []
    observed_session_ids: list[str | None] = []

    async def capture(event: dict[str, Any]) -> None:
        sent.append(event)

    async def no_git_identity(_user: object) -> None:
        return None

    async def stream_prompt(*_args: object, **_kwargs: object) -> AsyncIterator[dict[str, Any]]:
        observed_session_ids.append(bridge.opencode_session_id)
        yield {"type": "token", "content": "Continued", "messageId": "msg-after"}

    bridge._send_event = capture  # type: ignore[method-assign]
    bridge._configure_git_identity = no_git_identity  # type: ignore[method-assign]
    bridge._stream_opencode_response_sse = stream_prompt  # type: ignore[method-assign]

    await bridge._handle_context_compaction(
        {"requestId": "compact-continued", "model": "openai/gpt-5.6-sol"}
    )
    await bridge._handle_prompt({"messageId": "msg-after", "content": "Continue"})

    assert observed_session_ids == ["oc-session-123"]
    assert sent[-1] == {
        "type": "execution_complete",
        "messageId": "msg-after",
        "success": True,
    }


@pytest.mark.asyncio
async def test_session_error_reports_specific_compaction_failure(bridge: AgentBridge) -> None:
    bridge.http_client = MockHttpClient(
        [
            sse_event(
                "session.error",
                {
                    "sessionID": "oc-session-123",
                    "error": {"data": {"message": "Provider rejected summary"}},
                },
            )
        ]
    )
    sent: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any]) -> None:
        sent.append(event)

    bridge._send_event = capture  # type: ignore[method-assign]

    await bridge._handle_command(
        {"type": "compact_context", "requestId": "compact-2", "model": "openai/gpt-5.6-sol"}
    )
    task = bridge._current_compaction_task
    assert task is not None
    with contextlib.suppress(RuntimeError):
        await task
    await asyncio.sleep(0)

    assert sent == [
        {
            "type": "context_compaction_failed",
            "requestId": "compact-2",
            "error": "Provider rejected summary",
        }
    ]


@pytest.mark.asyncio
async def test_compaction_timeout_aborts_opencode(bridge: AgentBridge) -> None:
    class HangingResponse(MockSSEResponse):
        async def aiter_text(self) -> AsyncIterator[str]:
            await asyncio.sleep(60)
            if False:
                yield ""

    client = MockHttpClient([])
    client.stream = lambda *args, **kwargs: HangingResponse([])  # type: ignore[method-assign]
    bridge.http_client = client
    bridge.COMPACTION_MAX_DURATION = 0.01

    with pytest.raises(RuntimeError, match="timed out"):
        await bridge._handle_context_compaction(
            {"requestId": "compact-3", "model": "anthropic/claude-sonnet-4-6"}
        )

    assert client.posts[-1][0].endswith("/abort")


@pytest.mark.asyncio
async def test_bridge_rejects_compaction_while_prompt_is_active(bridge: AgentBridge) -> None:
    sent: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any]) -> None:
        sent.append(event)

    bridge._send_event = capture  # type: ignore[method-assign]
    bridge._current_prompt_task = asyncio.create_task(asyncio.sleep(60))

    await bridge._handle_command(
        {"type": "compact_context", "requestId": "compact-4", "model": "openai/gpt-5.6-sol"}
    )

    assert sent[0]["type"] == "context_compaction_failed"
    assert "idle" in sent[0]["error"]
    bridge._current_prompt_task.cancel()


@pytest.mark.asyncio
async def test_stop_cancels_compaction_and_aborts_opencode(bridge: AgentBridge) -> None:
    class HangingResponse(MockSSEResponse):
        async def aiter_text(self) -> AsyncIterator[str]:
            await asyncio.sleep(60)
            if False:
                yield ""

    client = MockHttpClient([])
    client.stream = lambda *args, **kwargs: HangingResponse([])  # type: ignore[method-assign]
    bridge.http_client = client
    sent: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any]) -> None:
        sent.append(event)

    bridge._send_event = capture  # type: ignore[method-assign]
    await bridge._handle_command(
        {"type": "compact_context", "requestId": "compact-5", "model": "openai/gpt-5.6-sol"}
    )
    await asyncio.sleep(0)

    await bridge._handle_stop()
    task = bridge._current_compaction_task
    if task:
        with contextlib.suppress(asyncio.CancelledError):
            await task
    await asyncio.sleep(0)

    assert any(url.endswith("/abort") for url, _body in client.posts)
    assert sent == [
        {
            "type": "context_compaction_failed",
            "requestId": "compact-5",
            "error": "Context compaction was cancelled",
        }
    ]
