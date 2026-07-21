#!/usr/bin/env python3
"""Reproduce OpenCode's native context-overflow recovery through AgentBridge."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx

from sandbox_runtime.bridge import AgentBridge

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

OPENCODE_VERSION = "1.14.41"
MODEL = "repro/repro-model"
INITIAL_PROMPT = "Complete the initial turn."
OVERFLOW_PROMPT = "Trigger the deterministic overflow and recover."
RECOVERY_TEXT = "Recovered after compaction."
EXPECTED_REQUESTS = ["title", "initial", "overflow", "compaction", "recovered"]

SUMMARY_TEXT = """## Goal
- Reproduce context overflow recovery.

## Constraints & Preferences
- Keep OpenCode as the owner of compaction.

## Progress
### Done
- Completed the initial turn.

### In Progress
- Recovering the overflowed turn.

### Blocked
- (none)

## Key Decisions
- Use native compaction and replay.

## Next Steps
- Complete the replayed request.

## Critical Context
- The provider returned a typed context overflow.

## Relevant Files
- (none)"""


class ProviderState:
    def __init__(self) -> None:
        self.condition = threading.Condition()
        self.requests: list[str] = []
        self.overflow_sent = False

    def classify(self, body: dict[str, Any]) -> str:
        serialized = json.dumps(body)
        with self.condition:
            if "Generate a title for this conversation" in serialized:
                label = "title"
            elif "Create a new anchored summary" in serialized and "<template>" in serialized:
                label = "compaction"
            elif OVERFLOW_PROMPT in serialized and not self.overflow_sent:
                self.overflow_sent = True
                label = "overflow"
            elif OVERFLOW_PROMPT in serialized:
                label = "recovered"
            elif INITIAL_PROMPT in serialized:
                self.condition.wait_for(lambda: "title" in self.requests, timeout=5)
                label = "initial"
            else:
                label = "unexpected"

            self.requests.append(label)
            self.condition.notify_all()
            return label


class ProviderServer(ThreadingHTTPServer):
    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), ProviderHandler)
        self.state = ProviderState()


class ProviderHandler(BaseHTTPRequestHandler):
    server: ProviderServer
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return

        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        label = self.server.state.classify(body)

        if label == "overflow":
            self._send_json(
                400,
                {
                    "error": {
                        "message": "Input exceeds context window of this model",
                        "type": "invalid_request_error",
                        "param": "messages",
                        "code": "context_length_exceeded",
                    }
                },
            )
            return

        response_text = {
            "title": "Context overflow reproduction",
            "initial": "Initial response.",
            "compaction": SUMMARY_TEXT,
            "recovered": RECOVERY_TEXT,
            "unexpected": "Unexpected provider request.",
        }[label]
        self._send_sse(response_text)

    def _send_json(self, status: int, body: dict[str, Any]) -> None:
        content = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _send_sse(self, text: str) -> None:
        chunks = [
            {
                "id": "chatcmpl-repro",
                "object": "chat.completion.chunk",
                "choices": [{"delta": {"role": "assistant"}}],
            },
            {
                "id": "chatcmpl-repro",
                "object": "chat.completion.chunk",
                "choices": [{"delta": {"content": text}}],
            },
            {
                "id": "chatcmpl-repro",
                "object": "chat.completion.chunk",
                "choices": [{"delta": {}, "finish_reason": "stop"}],
                "usage": {
                    "prompt_tokens": 128,
                    "completion_tokens": 8,
                    "total_tokens": 136,
                },
            },
        ]
        content = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks)
        content += "data: [DONE]\n\n"
        encoded = content.encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, _format: str, *args: object) -> None:
        return


def opencode_config(provider_url: str) -> dict[str, Any]:
    return {
        "model": MODEL,
        "small_model": MODEL,
        "permission": {"*": {"*": "allow"}},
        "compaction": {"auto": True},
        "provider": {
            "repro": {
                "name": "Deterministic reproduction provider",
                "npm": "@ai-sdk/openai-compatible",
                "options": {"baseURL": provider_url, "apiKey": "repro-key"},
                "models": {
                    "repro-model": {
                        "name": "Reproduction model",
                        "tool_call": False,
                        "limit": {"context": 4096, "output": 512},
                    }
                },
            }
        },
    }


def available_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def check_opencode_version() -> None:
    result = subprocess.run(
        ["opencode", "--version"],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    actual = result.stdout.strip()
    if actual != OPENCODE_VERSION:
        raise RuntimeError(f"Expected OpenCode {OPENCODE_VERSION}, found {actual or 'unknown'}")


def start_opencode(workdir: Path, provider_url: str, port: int) -> subprocess.Popen[bytes]:
    env = {
        **os.environ,
        "HOME": str(workdir / "home"),
        "XDG_CONFIG_HOME": str(workdir / "xdg"),
        "OPENCODE_CONFIG_CONTENT": json.dumps(opencode_config(provider_url)),
        "OPENCODE_CLIENT": "serve",
    }
    Path(env["HOME"]).mkdir()
    Path(env["XDG_CONFIG_HOME"]).mkdir()
    return subprocess.Popen(
        [
            "opencode",
            "serve",
            "--port",
            str(port),
            "--hostname",
            "127.0.0.1",
            "--print-logs",
        ],
        cwd=workdir,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )


async def wait_for_opencode(port: int, process: subprocess.Popen[bytes]) -> None:
    deadline = asyncio.get_running_loop().time() + 20
    async with httpx.AsyncClient() as client:
        while asyncio.get_running_loop().time() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"OpenCode exited during startup with {process.returncode}")
            try:
                response = await client.get(f"http://127.0.0.1:{port}/global/health", timeout=1)
                if response.is_success:
                    return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.1)
    raise RuntimeError("OpenCode did not become healthy")


async def collect_events(events: AsyncIterator[dict[str, Any]]) -> list[dict[str, Any]]:
    async with asyncio.timeout(30):
        return [event async for event in events]


def compaction_persisted(messages: list[dict[str, Any]]) -> bool:
    return any(
        message.get("info", {}).get("role") == "assistant"
        and message.get("info", {}).get("summary") is True
        and bool(message.get("info", {}).get("finish"))
        and not message.get("info", {}).get("error")
        and any(
            part.get("type") == "text" and part.get("text") for part in message.get("parts", [])
        )
        for message in messages
    )


def recovered_in_opencode(messages: list[dict[str, Any]]) -> bool:
    return any(
        message.get("info", {}).get("role") == "assistant"
        and not message.get("info", {}).get("summary")
        and any(
            part.get("type") == "text" and part.get("text") == RECOVERY_TEXT
            for part in message.get("parts", [])
        )
        for message in messages
    )


def recovered_in_bridge(events: list[dict[str, Any]]) -> bool:
    return not any(event.get("type") == "error" for event in events) and any(
        event.get("type") == "token" and event.get("content") == RECOVERY_TEXT for event in events
    )


async def wait_for_persisted_recovery(bridge: AgentBridge) -> list[dict[str, Any]]:
    if not bridge.http_client or not bridge.opencode_session_id:
        raise RuntimeError("Bridge session was not initialized")
    deadline = asyncio.get_running_loop().time() + 15
    url = f"{bridge.opencode_base_url}/session/{bridge.opencode_session_id}/message"
    while asyncio.get_running_loop().time() < deadline:
        response = await bridge.http_client.get(url)
        response.raise_for_status()
        messages = response.json()
        if recovered_in_opencode(messages):
            return messages
        await asyncio.sleep(0.1)
    return messages


async def reproduce() -> int:
    logging.disable(logging.CRITICAL)
    check_opencode_version()
    provider = ProviderServer()
    provider_thread = threading.Thread(target=provider.serve_forever, daemon=True)
    provider_thread.start()

    process: subprocess.Popen[bytes] | None = None
    bridge: AgentBridge | None = None
    try:
        with tempfile.TemporaryDirectory(prefix="context-overflow-repro-") as temporary:
            workdir = Path(temporary)
            port = available_port()
            provider_url = f"http://127.0.0.1:{provider.server_port}/v1"
            process = start_opencode(workdir, provider_url, port)
            await wait_for_opencode(port, process)

            bridge = AgentBridge(
                sandbox_id="context-overflow-repro",
                session_id="context-overflow-repro",
                control_plane_url="http://unused.invalid",
                auth_token="unused",
                opencode_port=port,
            )
            bridge.session_id_file = workdir / "session-id"
            bridge.http_client = httpx.AsyncClient(timeout=30)
            await bridge._create_opencode_session()

            await collect_events(
                bridge._stream_opencode_response_sse("bridge-initial", INITIAL_PROMPT, MODEL)
            )
            second_events = await collect_events(
                bridge._stream_opencode_response_sse("bridge-overflow", OVERFLOW_PROMPT, MODEL)
            )
            messages = await wait_for_persisted_recovery(bridge)

            request_labels = provider.state.requests
            persisted = compaction_persisted(messages)
            opencode_recovered = recovered_in_opencode(messages)
            bridge_recovered = recovered_in_bridge(second_events)

            print(f"provider_requests: {', '.join(request_labels)}")
            print(f"second_bridge_events: {', '.join(event['type'] for event in second_events)}")
            print(f"compaction_persisted: {str(persisted).lower()}")
            print(f"recovered_in_opencode: {str(opencode_recovered).lower()}")
            print(f"recovered_in_bridge: {str(bridge_recovered).lower()}")

            if request_labels == EXPECTED_REQUESTS and persisted and opencode_recovered:
                return 0 if bridge_recovered else 1
            return 2
    finally:
        if bridge and bridge.http_client:
            await bridge.http_client.aclose()
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        provider.shutdown()
        provider.server_close()
        provider_thread.join(timeout=5)


def main() -> int:
    try:
        return asyncio.run(reproduce())
    except Exception as error:
        print(f"reproduction_error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
