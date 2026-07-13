"""Unit tests for EventPump.

The pump sits between the SSE reader and the WebSocket sender so a slow send
never stalls the reader (which would make OpenCode sever the stream). These
tests pin the load-bearing behavior: order preservation, non-blocking enqueue,
overflow eviction that spares critical events, and draining fully on close.
"""

import asyncio
from typing import Any

import pytest

from sandbox_runtime.bridge import EventPump

CRITICAL_TYPES = {"execution_complete", "error"}
DROPPABLE_TYPES = {"token"}


def _token(i: int) -> dict[str, Any]:
    return {"type": "token", "content": f"t{i}"}


def _critical(name: str = "execution_complete") -> dict[str, Any]:
    return {"type": name}


def _tool(name: str) -> dict[str, Any]:
    return {"type": "tool_call", "name": name}


@pytest.mark.asyncio
async def test_delivers_events_to_sink_in_order():
    sent: list[dict[str, Any]] = []

    async def sink(event: dict[str, Any]) -> None:
        sent.append(event)

    pump = EventPump(
        sink, max_buffered=100, critical_types=CRITICAL_TYPES, droppable_types=DROPPABLE_TYPES
    )
    pump.start()
    for i in range(5):
        pump.enqueue(_token(i))
    dropped = await pump.aclose()

    assert dropped == 0
    assert [e["content"] for e in sent] == ["t0", "t1", "t2", "t3", "t4"]


@pytest.mark.asyncio
async def test_enqueue_does_not_block_on_a_slow_sink():
    gate = asyncio.Event()
    sent: list[dict[str, Any]] = []

    async def slow_sink(event: dict[str, Any]) -> None:
        await gate.wait()
        sent.append(event)

    pump = EventPump(
        slow_sink, max_buffered=100, critical_types=CRITICAL_TYPES, droppable_types=DROPPABLE_TYPES
    )
    pump.start()
    # The sink is gated, but the producer buffers all events without blocking.
    for i in range(5):
        pump.enqueue(_token(i))
    await asyncio.sleep(0)
    assert sent == []

    gate.set()
    dropped = await pump.aclose()
    assert dropped == 0
    assert [e["content"] for e in sent] == ["t0", "t1", "t2", "t3", "t4"]


@pytest.mark.asyncio
async def test_drops_oldest_non_critical_events_on_overflow():
    sent: list[dict[str, Any]] = []

    async def sink(event: dict[str, Any]) -> None:
        sent.append(event)

    # Enqueue before starting so eviction is deterministic (the pump can't drain
    # concurrently). Capacity 3, five events, two of which must be evicted.
    pump = EventPump(
        sink, max_buffered=3, critical_types=CRITICAL_TYPES, droppable_types=DROPPABLE_TYPES
    )
    pump.enqueue(_token(0))
    pump.enqueue(_token(1))
    pump.enqueue(_critical("execution_complete"))
    pump.enqueue(_token(2))  # evicts oldest superseded token: t0
    pump.enqueue(_token(3))  # evicts oldest superseded token: t1
    pump.start()
    dropped = await pump.aclose()

    assert dropped == 2
    assert [(e["type"], e.get("content")) for e in sent] == [
        ("execution_complete", None),
        ("token", "t2"),
        ("token", "t3"),
    ]


@pytest.mark.asyncio
async def test_never_drops_critical_events_while_non_critical_remain():
    sent: list[dict[str, Any]] = []

    async def sink(event: dict[str, Any]) -> None:
        sent.append(event)

    pump = EventPump(
        sink, max_buffered=2, critical_types=CRITICAL_TYPES, droppable_types=DROPPABLE_TYPES
    )
    pump.enqueue(_critical("error"))
    pump.enqueue(_token(0))
    pump.enqueue(_critical("execution_complete"))  # evicts the non-critical token
    pump.start()
    dropped = await pump.aclose()

    assert dropped == 1
    assert [e["type"] for e in sent] == ["error", "execution_complete"]


@pytest.mark.asyncio
async def test_prefers_dropping_tokens_over_discrete_events():
    sent: list[dict[str, Any]] = []

    async def sink(event: dict[str, Any]) -> None:
        sent.append(event)

    # A tool_call is discrete (not superseded), so it must outlive a token
    # under overflow even though both are non-critical.
    pump = EventPump(
        sink, max_buffered=3, critical_types=CRITICAL_TYPES, droppable_types=DROPPABLE_TYPES
    )
    pump.enqueue(_tool("bash"))
    pump.enqueue(_token(0))
    pump.enqueue(_token(1))
    pump.enqueue(_token(2))  # evicts a token, not the tool_call
    pump.start()
    dropped = await pump.aclose()

    assert dropped == 1
    assert [(e["type"], e.get("name", e.get("content"))) for e in sent] == [
        ("tool_call", "bash"),
        ("token", "t1"),
        ("token", "t2"),
    ]


@pytest.mark.asyncio
async def test_falls_back_to_non_critical_when_nothing_is_droppable():
    sent: list[dict[str, Any]] = []

    async def sink(event: dict[str, Any]) -> None:
        sent.append(event)

    # No tokens to shed, so eviction falls back to the oldest non-critical
    # event to bound memory.
    pump = EventPump(
        sink, max_buffered=2, critical_types=CRITICAL_TYPES, droppable_types=DROPPABLE_TYPES
    )
    pump.enqueue(_tool("a"))
    pump.enqueue(_tool("b"))
    pump.enqueue(_tool("c"))  # evicts the oldest tool_call: a
    pump.start()
    dropped = await pump.aclose()

    assert dropped == 1
    assert [e["name"] for e in sent] == ["b", "c"]


@pytest.mark.asyncio
async def test_aclose_drains_every_event_before_returning():
    sent: list[dict[str, Any]] = []

    async def sink(event: dict[str, Any]) -> None:
        await asyncio.sleep(0)  # yield, as a real WebSocket send would
        sent.append(event)

    pump = EventPump(
        sink, max_buffered=100, critical_types=CRITICAL_TYPES, droppable_types=DROPPABLE_TYPES
    )
    pump.start()
    for i in range(10):
        pump.enqueue(_token(i))

    await pump.aclose()
    # A terminal event sent after aclose is therefore guaranteed to land last.
    assert len(sent) == 10


@pytest.mark.asyncio
async def test_cancel_stops_the_pump_without_delivering_more():
    gate = asyncio.Event()
    sent: list[dict[str, Any]] = []

    async def slow_sink(event: dict[str, Any]) -> None:
        await gate.wait()
        sent.append(event)

    pump = EventPump(
        slow_sink, max_buffered=100, critical_types=CRITICAL_TYPES, droppable_types=DROPPABLE_TYPES
    )
    pump.start()
    pump.enqueue(_token(0))
    await asyncio.sleep(0)  # let the pump pick up the event and block on the sink

    pump.cancel()
    await asyncio.sleep(0)
    assert sent == []
