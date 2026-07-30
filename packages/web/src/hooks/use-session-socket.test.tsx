// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ServerMessage, SessionArtifact, SessionState } from "@open-inspect/shared";
import type * as SwrModule from "swr";
import { isUnarchivedSessionListKey } from "@/lib/session-list";
import { useSessionSocket } from "./use-session-socket";

type SubscribedMessage = Extract<ServerMessage, { type: "subscribed" }>;

const queuedPrompt = {
  messageId: "client-id",
  position: 2,
  content: "Run the tests next",
  timestamp: 2,
  author: { participantId: "participant-1", name: "Test User" },
};

const { mutateMock } = vi.hoisted(() => ({
  mutateMock: vi.fn(),
}));

vi.mock("swr", async () => {
  const actual = await vi.importActual<typeof SwrModule>("swr");
  return {
    ...actual,
    mutate: mutateMock,
  };
});

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = FakeWebSocket.CONNECTING;
  sentMessages: Array<Record<string, unknown>> = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true } as CloseEvent);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(message: ServerMessage) {
    this.onmessage?.({
      data: JSON.stringify(message),
    } as MessageEvent);
  }
}

function createSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: "session-1",
    title: "Session 1",
    repoOwner: "acme",
    repoName: "web-app",
    baseBranch: "main",
    branchName: "feature/original",
    status: "active",
    sandboxStatus: "ready",
    messageCount: 0,
    createdAt: 1,
    ...overrides,
  };
}

function createSubscribedMessage(artifacts: SessionArtifact[] = []): SubscribedMessage {
  return {
    type: "subscribed",
    sessionId: "session-1",
    state: createSessionState(),
    artifacts,
    participantId: "participant-1",
    participant: {
      participantId: "participant-1",
      name: "Test User",
    },
    replay: {
      events: [],
      hasMore: false,
      cursor: null,
    },
    spawnError: null,
  };
}

async function openSubscribedHook(state: Partial<SessionState> = {}) {
  const hook = renderHook(() => useSessionSocket("session-1"));
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0];
  act(() => {
    socket.open();
    const subscribed = createSubscribedMessage();
    subscribed.state = createSessionState(state);
    socket.receive(subscribed);
  });
  await waitFor(() => expect(hook.result.current.replaying).toBe(false));
  return { ...hook, socket };
}

function sendSandboxAccessMessages(socket: FakeWebSocket, sandboxId: string) {
  socket.receive({
    type: "code_server_info",
    url: `https://code.example/${sandboxId}`,
    password: "secret",
  });
  socket.receive({
    type: "sandbox_dashboard_url",
    url: `https://provider.example/${sandboxId}`,
  });
}

describe("useSessionSocket", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    mutateMock.mockReset();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          token: "ws-token",
        })
      )
    );
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("client-id");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps another tab's accepted compaction active when its own request is rejected", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.receive(createSubscribedMessage()));
    vi.mocked(globalThis.crypto.randomUUID).mockReturnValue("compact-request-2");

    act(() => result.current.compactContext("openai/gpt-5.6-sol"));
    expect(result.current.isCompacting).toBe(true);

    act(() => {
      socket.receive({
        type: "compaction_status",
        requestId: "compact-request-1",
        state: "in_progress",
      });
      socket.receive({
        type: "error",
        code: "SESSION_BUSY",
        message: "Context can only be compacted while the session is idle",
        requestId: "compact-request-2",
        activeRequestId: "compact-request-1",
      });
    });

    expect(result.current.isCompacting).toBe(true);
    expect(result.current.isProcessing).toBe(false);
  });

  it("reverts an optimistic prompt when another tab starts compaction", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.receive(createSubscribedMessage()));

    let delivery: ReturnType<typeof result.current.sendPrompt>;
    act(() => {
      delivery = result.current.sendPrompt("Race compaction");
    });
    expect(result.current.isProcessing).toBe(true);

    act(() => {
      socket.receive({
        type: "compaction_status",
        requestId: "compact-request-1",
        state: "in_progress",
      });
      socket.receive({
        type: "error",
        code: "COMPACTION_IN_PROGRESS",
        message: "Wait for context compaction to finish before sending a prompt",
        activeRequestId: "compact-request-1",
      });
    });

    expect(result.current.isProcessing).toBe(false);
    expect(result.current.isCompacting).toBe(true);
    await expect(delivery!).resolves.toEqual({
      ok: false,
      error: "Wait for context compaction to finish before sending a prompt",
    });
  });

  it("accepts a follow-up while processing and resolves after server acknowledgement", async () => {
    const { result, socket } = await openSubscribedHook({ isProcessing: true });

    let delivery: ReturnType<typeof result.current.sendPrompt>;
    act(() => {
      delivery = result.current.sendPrompt("Run the tests next", "anthropic/claude-sonnet-4-6");
    });

    expect(socket.sentMessages).toContainEqual({
      type: "prompt",
      requestId: "client-id",
      content: "Run the tests next",
      model: "anthropic/claude-sonnet-4-6",
    });

    act(() => {
      socket.receive({ type: "prompt_queued", messageId: "client-id", position: 2 });
    });
    expect(result.current.promptQueue).toEqual([
      expect.objectContaining({
        messageId: "client-id",
        position: 2,
        content: "Run the tests next",
      }),
    ]);

    act(() => {
      socket.receive({
        type: "prompt_queue",
        prompts: [queuedPrompt],
      });
    });

    await expect(delivery!).resolves.toEqual({ ok: true });
    expect(result.current.promptQueue).toEqual([queuedPrompt]);
  });

  it("accepts a server-generated prompt ID from an older control plane", async () => {
    const { result, socket } = await openSubscribedHook({ isProcessing: true });
    const delivery = result.current.sendPrompt("Run the tests next");

    act(() => {
      socket.receive({ type: "prompt_queued", messageId: "server-id", position: 2 });
    });

    await expect(delivery).resolves.toEqual({ ok: true });
    expect(result.current.promptQueue).toEqual([
      expect.objectContaining({
        messageId: "server-id",
        content: "Run the tests next",
        position: 2,
      }),
    ]);
  });

  it("restores queued prompt state from subscription", async () => {
    const { result, socket } = await openSubscribedHook({ isProcessing: true });
    const subscribed = createSubscribedMessage();
    subscribed.promptQueue = [queuedPrompt];

    act(() => socket.receive(subscribed));

    expect(result.current.promptQueue).toEqual([queuedPrompt]);
  });

  it("confirms a pending delivery from the queue snapshot after reconnect", async () => {
    const { result, socket } = await openSubscribedHook({ isProcessing: true });
    const delivery = result.current.sendPrompt("Run the tests next");

    act(() => socket.close());
    act(() => result.current.reconnect());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const reconnected = FakeWebSocket.instances[1];
    const subscribed = createSubscribedMessage();
    subscribed.promptQueue = [queuedPrompt];
    act(() => {
      reconnected.open();
      reconnected.receive(subscribed);
    });

    await expect(delivery).resolves.toEqual({ ok: true });
  });

  it("confirms a pending delivery from replay after it starts before reconnect", async () => {
    const { result, socket } = await openSubscribedHook({ isProcessing: true });
    const delivery = result.current.sendPrompt("Run the tests next");

    act(() => socket.close());
    act(() => result.current.reconnect());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const reconnected = FakeWebSocket.instances[1];
    const subscribed = createSubscribedMessage();
    subscribed.replay = {
      events: [
        {
          type: "user_message",
          messageId: "client-id",
          content: "Run the tests next",
          timestamp: 1_700_000_000,
        },
      ],
      hasMore: false,
      cursor: null,
    };
    act(() => {
      reconnected.open();
      reconnected.receive(subscribed);
    });

    await expect(delivery).resolves.toEqual({ ok: true });
  });

  it("confirms a pending delivery from the active prompt after reconnect", async () => {
    const { result, socket } = await openSubscribedHook({ isProcessing: true });
    const delivery = result.current.sendPrompt("Run the tests next");

    act(() => socket.close());
    act(() => result.current.reconnect());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const reconnected = FakeWebSocket.instances[1];
    const subscribed = createSubscribedMessage();
    subscribed.activePrompt = { ...queuedPrompt, position: 1 };
    act(() => {
      reconnected.open();
      reconnected.receive(subscribed);
    });

    await expect(delivery).resolves.toEqual({ ok: true });
    expect(result.current.events).toContainEqual(
      expect.objectContaining({ type: "user_message", messageId: "client-id" })
    );
  });

  it("does not reject prompt delivery for an unrelated server error", async () => {
    const { result, socket } = await openSubscribedHook({ isProcessing: true });
    const delivery = result.current.sendPrompt("Run the tests next");
    let settled = false;
    void delivery.then(() => {
      settled = true;
    });

    act(() => {
      socket.receive({ type: "error", code: "HISTORY_FAILED", message: "History failed" });
    });
    await act(async () => Promise.resolve());
    expect(settled).toBe(false);

    act(() => {
      socket.receive({ type: "prompt_queued", messageId: "client-id", position: 2 });
    });
    await expect(delivery).resolves.toEqual({ ok: true });
  });

  it("does not queue a duplicate acknowledgement for completed work", async () => {
    const { result, socket } = await openSubscribedHook({ isProcessing: true });
    const delivery = result.current.sendPrompt("Run the tests next");

    act(() => {
      socket.receive({ type: "prompt_queued", messageId: "client-id", status: "completed" });
    });

    await expect(delivery).resolves.toEqual({ ok: true });
    expect(result.current.promptQueue).toEqual([]);
  });

  it("rolls back optimistic processing when admission is rejected", async () => {
    const { result, socket } = await openSubscribedHook();
    let delivery: ReturnType<typeof result.current.sendPrompt>;
    act(() => {
      delivery = result.current.sendPrompt("Run the tests next");
    });
    expect(result.current.isProcessing).toBe(true);

    act(() => {
      socket.receive({
        type: "prompt_rejected",
        requestId: "client-id",
        message: "Wait for context compaction to finish before sending a prompt",
      });
    });

    await expect(delivery!).resolves.toEqual({
      ok: false,
      error: "Wait for context compaction to finish before sending a prompt",
    });
    expect(result.current.isProcessing).toBe(false);
  });

  it("preserves authoritative processing when a different run starts before rejection", async () => {
    const { result, socket } = await openSubscribedHook();
    let delivery: ReturnType<typeof result.current.sendPrompt>;
    act(() => {
      delivery = result.current.sendPrompt("Run the tests next");
    });

    act(() => {
      socket.receive({ type: "processing_status", isProcessing: true });
      socket.receive({
        type: "prompt_rejected",
        requestId: "client-id",
        message: "Request ID belongs to another prompt",
      });
    });

    await expect(delivery!).resolves.toEqual({
      ok: false,
      error: "Request ID belongs to another prompt",
    });
    expect(result.current.isProcessing).toBe(true);
  });

  it("rolls back optimistic processing when admission times out", async () => {
    const { result } = await openSubscribedHook();
    vi.useFakeTimers();
    let delivery: ReturnType<typeof result.current.sendPrompt>;
    act(() => {
      delivery = result.current.sendPrompt("Run the tests next");
    });
    expect(result.current.isProcessing).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    await expect(delivery!).resolves.toEqual({
      ok: false,
      error: "The server did not confirm the message. Retry is safe.",
    });
    expect(result.current.isProcessing).toBe(false);
  });

  it("reuses the request ID when an accepted prompt loses its acknowledgement", async () => {
    const { result, socket } = await openSubscribedHook({ isProcessing: true });
    vi.useFakeTimers();
    const firstDelivery = result.current.sendPrompt("Run the tests next");

    act(() => {
      socket.receive({ type: "prompt_queue", prompts: [queuedPrompt] });
      socket.close();
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(firstDelivery).resolves.toEqual({
      ok: false,
      error: "The server did not confirm the message. Retry is safe.",
    });
    expect(result.current.isProcessing).toBe(true);

    vi.useRealTimers();
    act(() => result.current.reconnect());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const reconnected = FakeWebSocket.instances[1];
    act(() => {
      reconnected.open();
      reconnected.receive(createSubscribedMessage());
    });
    await waitFor(() => expect(result.current.connected).toBe(true));

    const retry = result.current.sendPrompt("Run the tests next");
    const firstPrompt = socket.sentMessages.find((message) => message.type === "prompt");
    const retriedPrompt = reconnected.sentMessages.find((message) => message.type === "prompt");
    expect(retriedPrompt?.requestId).toBe(firstPrompt?.requestId);

    act(() => {
      reconnected.receive({ type: "prompt_queued", messageId: "client-id", position: 2 });
    });
    await expect(retry).resolves.toEqual({ ok: true });
  });

  it("reuses the request ID when acknowledgement arrives after the timeout", async () => {
    const { result, socket } = await openSubscribedHook({ isProcessing: true });
    vi.useFakeTimers();
    const firstDelivery = result.current.sendPrompt("Run the tests next");

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(firstDelivery).resolves.toEqual({
      ok: false,
      error: "The server did not confirm the message. Retry is safe.",
    });
    act(() => {
      socket.receive({
        type: "prompt_queued",
        messageId: "client-id",
        position: 2,
        status: "pending",
      });
    });

    const retry = result.current.sendPrompt("Run the tests next");
    const prompts = socket.sentMessages.filter((message) => message.type === "prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1].requestId).toBe(prompts[0].requestId);

    act(() => {
      socket.receive({
        type: "prompt_queued",
        messageId: "client-id",
        position: 2,
        status: "pending",
      });
    });
    await expect(retry).resolves.toEqual({ ok: true });
  });

  it("rejects delivery while disconnected so the draft can be retried", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await expect(result.current.sendPrompt("Keep this draft")).resolves.toEqual({
      ok: false,
      error: "Not connected. Reconnect and try again.",
    });
  });

  it("hydrates artifacts from the subscribed payload", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });

    act(() => {
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/42",
            metadata: {
              number: 42,
              state: "open",
              head: "feature/test",
              base: "main",
            },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-pr-1",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/42",
          metadata: expect.objectContaining({
            prNumber: 42,
            prState: "open",
            head: "feature/test",
            base: "main",
          }),
          createdAt: 1234,
        },
      ]);
    });
  });

  it("hydrates screenshot metadata from subscribed artifacts", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });

    act(() => {
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-shot-1",
            type: "screenshot",
            url: "sessions/session-1/media/artifact-shot-1.png",
            metadata: {
              objectKey: "sessions/session-1/media/artifact-shot-1.png",
              mimeType: "image/png",
              sizeBytes: 512,
              caption: "Dashboard after fix",
              sourceUrl: "http://127.0.0.1:3000",
              fullPage: true,
              annotated: false,
              viewport: { width: 1440, height: 900 },
            },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-shot-1",
          type: "screenshot",
          url: "sessions/session-1/media/artifact-shot-1.png",
          metadata: expect.objectContaining({
            objectKey: "sessions/session-1/media/artifact-shot-1.png",
            mimeType: "image/png",
            sizeBytes: 512,
            caption: "Dashboard after fix",
            sourceUrl: "http://127.0.0.1:3000",
            fullPage: true,
            annotated: false,
            viewport: { width: 1440, height: 900 },
          }),
          createdAt: 1234,
        },
      ]);
    });
  });

  it("hydrates SVG screenshot metadata from subscribed artifacts", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });

    act(() => {
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-svg-1",
            type: "screenshot",
            url: "sessions/session-1/media/artifact-svg-1.svg",
            metadata: {
              objectKey: "sessions/session-1/media/artifact-svg-1.svg",
              mimeType: "image/svg+xml",
              sizeBytes: 256,
              caption: "Request flow diagram",
            },
            createdAt: 4321,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-svg-1",
          type: "screenshot",
          url: "sessions/session-1/media/artifact-svg-1.svg",
          metadata: expect.objectContaining({
            objectKey: "sessions/session-1/media/artifact-svg-1.svg",
            mimeType: "image/svg+xml",
            sizeBytes: 256,
            caption: "Request flow diagram",
          }),
          createdAt: 4321,
        },
      ]);
    });
  });

  it("revalidates the sidebar session list on title updates", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
      socket.receive({ type: "session_title", title: "Generated title" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.title).toBe("Generated title");
    });

    expect(mutateMock).toHaveBeenCalledWith(isUnarchivedSessionListKey);
  });

  it("hydrates replayed assistant text before completion when storage ordering is tied", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    const subscribed = createSubscribedMessage();
    subscribed.replay = {
      events: [
        {
          type: "execution_complete",
          messageId: "msg-1",
          success: true,
          sandboxId: "sb-1",
          timestamp: 2,
        },
        {
          type: "token",
          content: "Final response",
          messageId: "msg-1",
          sandboxId: "sb-1",
          timestamp: 1,
        },
      ],
      hasMore: false,
      cursor: null,
    };

    act(() => {
      socket.open();
      socket.receive(subscribed);
    });

    await waitFor(() => {
      expect(result.current.events).toEqual([
        expect.objectContaining({
          type: "token",
          content: "Final response",
          messageId: "msg-1",
        }),
        expect.objectContaining({
          type: "execution_complete",
          messageId: "msg-1",
          success: true,
        }),
      ]);
    });
  });

  it("hydrates video metadata from subscribed artifacts", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });

    act(() => {
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-video-1",
            type: "video",
            url: "sessions/session-1/media/artifact-video-1.mp4",
            metadata: {
              objectKey: "sessions/session-1/media/artifact-video-1.mp4",
              mimeType: "video/mp4",
              sizeBytes: 4096,
              caption: "Menu interaction",
              sourceUrl: "http://127.0.0.1:3000/start",
              endUrl: "http://127.0.0.1:3000/end",
              durationMs: 1450,
              recordingStartedAt: 1000,
              recordingEndedAt: 2450,
              dimensions: { width: 1280, height: 720 },
              truncated: false,
              hasAudio: false,
            },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-video-1",
          type: "video",
          url: "sessions/session-1/media/artifact-video-1.mp4",
          metadata: expect.objectContaining({
            objectKey: "sessions/session-1/media/artifact-video-1.mp4",
            mimeType: "video/mp4",
            sizeBytes: 4096,
            caption: "Menu interaction",
            sourceUrl: "http://127.0.0.1:3000/start",
            endUrl: "http://127.0.0.1:3000/end",
            durationMs: 1450,
            recordingStartedAt: 1000,
            recordingEndedAt: 2450,
            dimensions: { width: 1280, height: 720 },
            truncated: false,
            hasAudio: false,
          }),
          createdAt: 1234,
        },
      ]);
    });
  });

  it("drops wrong-type metadata fields during narrowing", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });

    act(() => {
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-shot-wrong-types",
            type: "screenshot",
            url: "sessions/session-1/media/artifact-shot-wrong-types.png",
            metadata: {
              objectKey: "sessions/session-1/media/artifact-shot-wrong-types.png",
              mimeType: "image/png",
              sizeBytes: "five",
              viewport: "not-an-object",
            },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-shot-wrong-types",
          type: "screenshot",
          url: "sessions/session-1/media/artifact-shot-wrong-types.png",
          metadata: expect.objectContaining({
            objectKey: "sessions/session-1/media/artifact-shot-wrong-types.png",
            mimeType: "image/png",
            sizeBytes: undefined,
            viewport: undefined,
          }),
          createdAt: 1234,
        },
      ]);
    });
  });

  it("replaces stale artifacts with the subscribed snapshot", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/42",
            metadata: { number: 42, state: "open" },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toHaveLength(1);
    });

    act(() => {
      socket.receive(createSubscribedMessage());
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([]);
    });
  });

  it("updates sessionState.branchName from session_branch without mutating the sidebar cache", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });

    act(() => {
      socket.receive({ type: "session_branch", branchName: "feature/live-update" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.branchName).toBe("feature/live-update");
    });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("routes a repo-scoped session_branch to the matching member, mirroring the scalar only for the primary", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    const multiRepoState = createSessionState({
      branchName: "open-inspect/session-1",
      repositories: [
        {
          position: 0,
          repoOwner: "acme",
          repoName: "web",
          repoId: 1,
          baseBranch: "main",
          branchName: "open-inspect/session-1",
          baseSha: null,
          currentSha: null,
          prUrl: null,
        },
        {
          position: 1,
          repoOwner: "acme",
          repoName: "api",
          repoId: 2,
          baseBranch: "main",
          branchName: null,
          baseSha: null,
          currentSha: null,
          prUrl: null,
        },
      ],
    });

    act(() => {
      socket.open();
      socket.receive({ ...createSubscribedMessage(), state: multiRepoState });
    });

    // Secondary push: update the member, leave the scalar (primary) branch alone.
    act(() => {
      socket.receive({
        type: "session_branch",
        branchName: "open-inspect/session-1-api",
        repoOwner: "acme",
        repoName: "api",
      });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.repositories?.[1].branchName).toBe(
        "open-inspect/session-1-api"
      );
    });
    expect(result.current.sessionState?.repositories?.[0].branchName).toBe(
      "open-inspect/session-1"
    );
    expect(result.current.sessionState?.branchName).toBe("open-inspect/session-1");

    // Primary push: update the member and mirror to the scalar.
    act(() => {
      socket.receive({
        type: "session_branch",
        branchName: "open-inspect/session-1-web",
        repoOwner: "acme",
        repoName: "web",
      });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.branchName).toBe("open-inspect/session-1-web");
    });
    expect(result.current.sessionState?.repositories?.[0].branchName).toBe(
      "open-inspect/session-1-web"
    );
  });

  it("ignores an unscoped session_branch for a multi-repo session", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    const multiRepoState = createSessionState({
      branchName: "open-inspect/session-1",
      repositories: [
        {
          position: 0,
          repoOwner: "acme",
          repoName: "web",
          repoId: 1,
          baseBranch: "main",
          branchName: "open-inspect/session-1",
          baseSha: null,
          currentSha: null,
          prUrl: null,
        },
        {
          position: 1,
          repoOwner: "acme",
          repoName: "api",
          repoId: 2,
          baseBranch: "main",
          branchName: null,
          baseSha: null,
          currentSha: null,
          prUrl: null,
        },
      ],
    });

    act(() => {
      socket.open();
      socket.receive({ ...createSubscribedMessage(), state: multiRepoState });
    });

    // An identity-less update on a multi-repo session is anomalous — it must not
    // be attributed to the primary or clobber the scalar branch.
    act(() => {
      socket.receive({ type: "session_branch", branchName: "open-inspect/session-1-orphan" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.repositories).toBeTruthy();
    });
    expect(result.current.sessionState?.branchName).toBe("open-inspect/session-1");
    expect(result.current.sessionState?.repositories?.[0].branchName).toBe(
      "open-inspect/session-1"
    );
    expect(result.current.sessionState?.repositories?.[1].branchName).toBeNull();
  });

  it("updates sessionState.sandboxDashboardUrl from sandbox_dashboard_url", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });

    act(() => {
      socket.receive({
        type: "sandbox_dashboard_url",
        url: "https://provider.example/sandbox-123",
      });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/sandbox-123"
      );
    });
  });

  it("clears credentials on spawn and terminal statuses without dropping diagnostic links early", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
      sendSandboxAccessMessages(socket, "old-sandbox");
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/old-sandbox"
      );
      expect(result.current.sessionState?.codeServerUrl).toBe("https://code.example/old-sandbox");
    });

    act(() => {
      socket.receive({ type: "sandbox_spawning" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxStatus).toBe("spawning");
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/old-sandbox"
      );
      expect(result.current.sessionState?.codeServerUrl).toBeUndefined();
    });

    act(() => {
      socket.receive({ type: "sandbox_status", status: "spawning" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxStatus).toBe("spawning");
      expect(result.current.sessionState?.sandboxDashboardUrl).toBeUndefined();
      expect(result.current.sessionState?.codeServerUrl).toBeUndefined();
    });

    act(() => {
      sendSandboxAccessMessages(socket, "new-sandbox");
      socket.receive({ type: "sandbox_status", status: "failed" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxStatus).toBe("failed");
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/new-sandbox"
      );
      expect(result.current.sessionState?.codeServerUrl).toBeUndefined();
    });
  });

  it("clears dashboard URL only for replacement starts, not sandbox errors", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
      sendSandboxAccessMessages(socket, "old-sandbox");
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/old-sandbox"
      );
      expect(result.current.sessionState?.codeServerUrl).toBe("https://code.example/old-sandbox");
    });

    act(() => {
      socket.receive({ type: "sandbox_status", status: "spawning" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxStatus).toBe("spawning");
      expect(result.current.sessionState?.sandboxDashboardUrl).toBeUndefined();
      expect(result.current.sessionState?.codeServerUrl).toBeUndefined();
    });

    act(() => {
      sendSandboxAccessMessages(socket, "new-sandbox");
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/new-sandbox"
      );
      expect(result.current.sessionState?.codeServerUrl).toBe("https://code.example/new-sandbox");
    });

    act(() => {
      socket.receive({ type: "sandbox_error", error: "spawn failed" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxStatus).toBe("failed");
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/new-sandbox"
      );
      expect(result.current.sessionState?.codeServerUrl).toBeUndefined();
    });
  });

  it("prepends new artifacts and replaces duplicates by id", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/1",
            metadata: { number: 1, state: "open" },
            createdAt: 100,
          },
        ])
      );
    });

    act(() => {
      socket.receive({
        type: "artifact_created",
        artifact: {
          id: "artifact-pr-2",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/2",
          metadata: { number: 2, state: "draft" },
          createdAt: 200,
        },
      });
    });

    await waitFor(() => {
      expect(result.current.artifacts.map((artifact) => artifact.id)).toEqual([
        "artifact-pr-2",
        "artifact-pr-1",
      ]);
    });

    act(() => {
      socket.receive({
        type: "artifact_created",
        artifact: {
          id: "artifact-pr-1",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/1-updated",
          metadata: { number: 1, state: "closed" },
          createdAt: 300,
        },
      });
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-pr-2",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/2",
          metadata: expect.objectContaining({
            prNumber: 2,
            prState: "draft",
          }),
          createdAt: 200,
        },
        {
          id: "artifact-pr-1",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/1-updated",
          metadata: expect.objectContaining({
            prNumber: 1,
            prState: "closed",
          }),
          createdAt: 300,
        },
      ]);
    });

    // A new PR changes the sidebar summary, so creation revalidates the
    // session list just like artifact_updated.
    expect(mutateMock).toHaveBeenCalledWith(isUnarchivedSessionListKey);
  });

  it("applies artifact_updated in place and revalidates the session list", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-pr-2",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/2",
            metadata: { number: 2, state: "open" },
            createdAt: 200,
          },
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/1",
            metadata: { number: 1, state: "open" },
            createdAt: 100,
          },
        ])
      );
    });
    mutateMock.mockClear();

    act(() => {
      socket.receive({
        type: "artifact_updated",
        artifact: {
          id: "artifact-pr-1",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/1",
          metadata: {
            number: 1,
            state: "merged",
            lifecycleState: "merged",
            isDraft: false,
          },
          createdAt: 100,
          updatedAt: 500,
        },
      });
    });

    await waitFor(() => {
      // Updated in place — the list order is stable, no reshuffle.
      expect(
        result.current.artifacts.map((artifact) => [artifact.id, artifact.metadata?.prState])
      ).toEqual([
        ["artifact-pr-2", "open"],
        ["artifact-pr-1", "merged"],
      ]);
      expect(result.current.artifacts[1].updatedAt).toBe(500);
    });

    expect(mutateMock).toHaveBeenCalledWith(isUnarchivedSessionListKey);
  });

  it("does not revalidate the session list for non-PR artifacts", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage([]));
    });
    mutateMock.mockClear();

    act(() => {
      socket.receive({
        type: "artifact_created",
        artifact: {
          id: "artifact-shot-1",
          type: "screenshot",
          url: "https://example.com/shot.png",
          metadata: null,
          createdAt: 100,
        },
      });
    });

    await waitFor(() => {
      // The artifact still upserts into the session view; only the sidebar
      // revalidation is PR-gated (media events arrive at high frequency).
      expect(result.current.artifacts.map((artifact) => artifact.id)).toEqual(["artifact-shot-1"]);
    });
    expect(mutateMock).not.toHaveBeenCalledWith(isUnarchivedSessionListKey);
  });

  it("derives prState from tracked lifecycle metadata over the legacy state key", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-pr-draft",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/3",
            // Stale legacy display key vs. tracked lifecycle: lifecycle wins.
            metadata: { number: 3, state: "open", lifecycleState: "open", isDraft: true },
            createdAt: 100,
          },
          {
            id: "artifact-pr-legacy",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/4",
            metadata: { number: 4, state: "closed" },
            createdAt: 50,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts.map((artifact) => artifact.metadata?.prState)).toEqual([
        "draft",
        "closed",
      ]);
    });
  });
});
