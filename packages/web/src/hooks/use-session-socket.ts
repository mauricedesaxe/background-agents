"use client";

import { useCallback, useReducer, useRef, useState } from "react";
import { mutate } from "swr";
import { toast } from "sonner";
import { useSessionTransport } from "@/hooks/use-session-transport";
import {
  ingestLiveSandboxEvent,
  pendingToTokenEvent,
  toUiSandboxEvent,
  type PendingAssistantText,
} from "@/lib/session-socket/event-log";
import { initialSessionSocketState, sessionSocketReducer } from "@/lib/session-socket/reducer";
import { swrKeysToRevalidate } from "@/lib/session-socket/swr-revalidation";
import type { Artifact, SandboxEvent } from "@/types/session";
import type {
  ParticipantPresence,
  PromptSnapshotItem,
  ServerMessage,
  SessionState,
} from "@open-inspect/shared";

const PROMPT_ACK_TIMEOUT_MS = 10_000;
const HISTORY_PAGE_SIZE = 200;
const COMPACTION_REQUEST_ERROR_CODES = new Set([
  "SESSION_BUSY",
  "INVALID_MODEL",
  "SANDBOX_UNAVAILABLE",
  "COMPACTION_DISPATCH_FAILED",
]);

interface Message {
  id: string;
  authorId: string;
  content: string;
  source: string;
  status: string;
  createdAt: number;
}

const NO_MESSAGES: Message[] = [];

interface UseSessionSocketReturn {
  connected: boolean;
  connecting: boolean;
  replaying: boolean;
  authError: string | null;
  connectionError: string | null;
  sessionState: SessionState | null;
  messages: Message[];
  events: SandboxEvent[];
  participants: ParticipantPresence[];
  artifacts: Artifact[];
  currentParticipantId: string | null;
  isProcessing: boolean;
  isCompacting: boolean;
  promptQueue: PromptSnapshotItem[];
  hasMoreHistory: boolean;
  loadingHistory: boolean;
  sendPrompt: (
    content: string,
    model?: string,
    reasoningEffort?: string
  ) => Promise<PromptDeliveryResult>;
  compactContext: (model: string) => void;
  stopExecution: () => void;
  sendTyping: () => void;
  reconnect: () => void;
  loadOlderEvents: () => void;
}

type PromptDeliveryResult = { ok: true } | { ok: false; error: string };

interface PendingPromptDelivery {
  requestId: string;
  optimisticProcessing: boolean;
  processingStatusVersion: number;
  resolve: (result: PromptDeliveryResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface RetryablePrompt {
  requestId: string;
  content: string;
  model?: string;
  reasoningEffort?: string;
}

/**
 * Session view over a WebSocket connection, composed from four layers:
 *
 * - transport (connect/auth/reconnect/ping): `useSessionTransport`
 * - event-log construction and token buffering: `lib/session-socket/event-log`
 * - view-state projection: `lib/session-socket/reducer`
 * - SWR revalidation: `lib/session-socket/swr-revalidation` (applied below,
 *   the only place this hook touches the cache)
 */
export function useSessionSocket(sessionId: string): UseSessionSocketReturn {
  const [state, dispatch] = useReducer(sessionSocketReducer, initialSessionSocketState);
  const [promptQueue, setPromptQueue] = useState<PromptSnapshotItem[]>([]);
  const subscribedRef = useRef(false);
  const pendingCompactionRequestRef = useRef<string | null>(null);
  const activeCompactionRequestRef = useRef<string | null>(null);
  const processingStatusVersionRef = useRef(0);
  const pendingPromptDeliveryRef = useRef<PendingPromptDelivery | null>(null);
  const retryablePromptRef = useRef<RetryablePrompt | null>(null);
  // Buffers streamed assistant text in a ref so token events (which arrive at
  // high frequency) don't re-render; the text is appended on completion.
  const pendingTextRef = useRef<PendingAssistantText | null>(null);

  const finishPromptDelivery = useCallback(
    (requestId: string, result: PromptDeliveryResult, clearRetry: boolean) => {
      const pending = pendingPromptDeliveryRef.current;
      if (pending?.requestId === requestId) {
        clearTimeout(pending.timeout);
        pendingPromptDeliveryRef.current = null;
        if (
          !result.ok &&
          pending.optimisticProcessing &&
          pending.processingStatusVersion === processingStatusVersionRef.current
        ) {
          dispatch({ type: "prompt_rejected" });
        }
        pending.resolve(result);
        if (clearRetry && retryablePromptRef.current?.requestId === requestId) {
          retryablePromptRef.current = null;
        }
      }
    },
    []
  );

  const handleMessage = useCallback(
    (message: ServerMessage) => {
      if (message.type === "sandbox_event") {
        const event = toUiSandboxEvent(message.event);
        const { pending, append } = ingestLiveSandboxEvent(pendingTextRef.current, event);
        pendingTextRef.current = pending;
        if (append.length > 0) {
          dispatch({ type: "events_appended", events: append });
        }
        if (event.type === "context_compacted" || event.type === "context_compaction_failed") {
          activeCompactionRequestRef.current = null;
          if (event.type === "context_compaction_failed") {
            toast.error(event.error);
          }
        }
        return;
      }

      if (message.type === "subscribed") {
        console.log("WebSocket subscribed to session");
        subscribedRef.current = true;
        processingStatusVersionRef.current += 1;
        setPromptQueue(message.promptQueue ?? []);
        const pendingDelivery = pendingPromptDeliveryRef.current;
        if (
          pendingDelivery &&
          (message.promptQueue?.some((prompt) => prompt.messageId === pendingDelivery.requestId) ||
            message.activePrompt?.messageId === pendingDelivery.requestId ||
            message.replay?.events.some(
              (event) => "messageId" in event && event.messageId === pendingDelivery.requestId
            ))
        ) {
          finishPromptDelivery(pendingDelivery.requestId, { ok: true }, true);
        }
        pendingTextRef.current = null;
        if (message.spawnError && message.state.sandboxStatus === "failed") {
          console.error("Sandbox spawn error:", message.spawnError);
        }
      } else if (message.type === "compaction_status") {
        activeCompactionRequestRef.current =
          message.state === "in_progress" ? message.requestId : null;
        if (pendingCompactionRequestRef.current === message.requestId) {
          pendingCompactionRequestRef.current = null;
        }
      } else if (message.type === "sandbox_error") {
        console.error("Sandbox error:", message.error);
      } else if (message.type === "processing_status") {
        processingStatusVersionRef.current += 1;
      } else if (message.type === "error") {
        console.error("Session error:", message);
        if (message.code === "COMPACTION_IN_PROGRESS") {
          const pending = pendingPromptDeliveryRef.current;
          if (pending) {
            finishPromptDelivery(pending.requestId, { ok: false, error: message.message }, true);
          }
          if (message.activeRequestId) {
            activeCompactionRequestRef.current = message.activeRequestId;
            dispatch({ type: "compaction_active" });
          }
        } else if (
          COMPACTION_REQUEST_ERROR_CODES.has(message.code) &&
          message.requestId === pendingCompactionRequestRef.current
        ) {
          pendingCompactionRequestRef.current = null;
          if (message.activeRequestId) {
            activeCompactionRequestRef.current = message.activeRequestId;
            dispatch({ type: "compaction_active" });
          } else if (!activeCompactionRequestRef.current) {
            dispatch({ type: "compaction_rejected" });
          }
        }
        toast.error(message.message);
      } else if (message.type === "prompt_queued") {
        const pendingDelivery = pendingPromptDeliveryRef.current;
        const deliveryRequestId = pendingDelivery?.requestId ?? message.messageId;
        const retryable = retryablePromptRef.current;
        setPromptQueue((current) => {
          if (message.status && message.status !== "pending") {
            return current.filter((prompt) => prompt.messageId !== message.messageId);
          }
          const existing = current.find((prompt) => prompt.messageId === message.messageId);
          if (!existing && retryable?.requestId !== deliveryRequestId) return current;
          const accepted = existing ?? {
            messageId: message.messageId,
            content: retryable!.content,
            timestamp: Date.now() / 1000,
            position: message.position ?? 1,
          };
          return [
            ...current.filter((prompt) => prompt.messageId !== message.messageId),
            { ...accepted, position: message.position ?? accepted.position },
          ].sort((left, right) => left.position - right.position);
        });
        finishPromptDelivery(deliveryRequestId, { ok: true }, true);
      } else if (message.type === "prompt_rejected") {
        finishPromptDelivery(message.requestId, { ok: false, error: message.message }, true);
      } else if (message.type === "prompt_queue") {
        setPromptQueue(message.prompts);
      }

      dispatch({ type: "server_message", message });
      for (const key of swrKeysToRevalidate(message, sessionId)) {
        mutate(key);
      }
    },
    [finishPromptDelivery, sessionId]
  );

  const handleClose = useCallback(() => {
    subscribedRef.current = false;
    dispatch({ type: "socket_closed" });
  }, []);

  const transport = useSessionTransport(sessionId, {
    onMessage: handleMessage,
    onClose: handleClose,
  });
  const { isOpen, send } = transport;

  const sendPrompt = useCallback(
    (content: string, model?: string, reasoningEffort?: string): Promise<PromptDeliveryResult> => {
      if (!isOpen()) {
        return Promise.resolve({ ok: false, error: "Not connected. Reconnect and try again." });
      }

      if (!subscribedRef.current) {
        return Promise.resolve({ ok: false, error: "Still connecting. Try again shortly." });
      }

      if (pendingPromptDeliveryRef.current) {
        return Promise.resolve({ ok: false, error: "Another message is still being queued." });
      }

      console.log("Sending prompt", {
        contentLength: content.length,
        model,
        reasoningEffort,
      });

      const retryable = retryablePromptRef.current;
      const requestId =
        retryable &&
        retryable.content === content &&
        retryable.model === model &&
        retryable.reasoningEffort === reasoningEffort
          ? retryable.requestId
          : crypto.randomUUID();
      retryablePromptRef.current = { requestId, content, model, reasoningEffort };
      const optimisticProcessing = !(state.sessionState?.isProcessing ?? false);
      if (optimisticProcessing) dispatch({ type: "prompt_sent" });

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          finishPromptDelivery(
            requestId,
            {
              ok: false,
              error: "The server did not confirm the message. Retry is safe.",
            },
            false
          );
        }, PROMPT_ACK_TIMEOUT_MS);
        pendingPromptDeliveryRef.current = {
          requestId,
          optimisticProcessing,
          processingStatusVersion: processingStatusVersionRef.current,
          resolve,
          timeout,
        };

        send({
          type: "prompt",
          requestId,
          content,
          model,
          reasoningEffort,
        });
      });
    },
    [finishPromptDelivery, isOpen, send, state.sessionState?.isProcessing]
  );

  const compactContext = useCallback(
    (model: string) => {
      if (!isOpen() || !subscribedRef.current) {
        toast.error("Connect to the session before compacting context");
        return;
      }

      const requestId = crypto.randomUUID();
      pendingCompactionRequestRef.current = requestId;
      dispatch({ type: "compaction_sent" });
      send({ type: "compact_context", requestId, model });
    },
    [isOpen, send]
  );

  const stopExecution = useCallback(() => {
    if (!isOpen()) {
      return;
    }
    const pending = pendingTextRef.current;
    pendingTextRef.current = null;
    if (pending) {
      dispatch({ type: "events_appended", events: [pendingToTokenEvent(pending)] });
    }
    send({ type: "stop" });
  }, [isOpen, send]);

  const sendTyping = useCallback(() => {
    if (!isOpen()) {
      return;
    }
    send({ type: "typing" });
  }, [isOpen, send]);

  const { hasMoreHistory, loadingHistory, cursor } = state;
  const loadOlderEvents = useCallback(() => {
    if (!isOpen()) return;
    if (!hasMoreHistory || loadingHistory || !cursor) return;
    dispatch({ type: "history_requested" });
    send({
      type: "fetch_history",
      cursor,
      limit: HISTORY_PAGE_SIZE,
    });
  }, [isOpen, send, hasMoreHistory, loadingHistory, cursor]);

  const isProcessing = state.sessionState?.isProcessing ?? false;
  const isCompacting = state.sessionState?.isCompacting ?? false;

  return {
    connected: transport.connected,
    connecting: transport.connecting,
    replaying: state.replaying,
    authError: transport.authError,
    connectionError: transport.connectionError,
    sessionState: state.sessionState,
    messages: NO_MESSAGES,
    events: state.events,
    participants: state.participants,
    artifacts: state.artifacts,
    currentParticipantId: state.currentParticipantId,
    isProcessing,
    isCompacting,
    promptQueue,
    hasMoreHistory,
    loadingHistory,
    sendPrompt,
    compactContext,
    stopExecution,
    sendTyping,
    reconnect: transport.reconnect,
    loadOlderEvents,
  };
}
