// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SandboxEvent } from "@/types/session";
import { EventItem } from "./session-timeline";

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

describe("EventItem", () => {
  it("renders the start of context compaction in the timeline", () => {
    const event: SandboxEvent = {
      type: "context_compaction_started",
      requestId: "compact-1",
      sandboxId: "sandbox-1",
      timestamp: 1_700_000_000,
    };

    render(
      <EventItem
        event={event}
        sessionId="session-1"
        currentParticipantId={null}
        onOpenMedia={vi.fn()}
      />
    );

    expect(screen.getByText("Context compaction started")).toBeInTheDocument();
  });

  it("renders context compaction as a neutral timeline status", () => {
    const event: SandboxEvent = {
      type: "context_compacted",
      messageId: "message-1",
      sandboxId: "sandbox-1",
      timestamp: 1_700_000_000,
    };

    render(
      <EventItem
        event={event}
        sessionId="session-1"
        currentParticipantId={null}
        onOpenMedia={vi.fn()}
        queuePosition={undefined}
      />
    );

    expect(screen.getByText("Context compacted")).toBeInTheDocument();
  });

  it("renders a specific context compaction failure", () => {
    const event: SandboxEvent = {
      type: "context_compaction_failed",
      requestId: "compact-1",
      error: "Provider rejected summary",
      sandboxId: "sandbox-1",
      timestamp: 1_700_000_000,
    };

    render(
      <EventItem
        event={event}
        sessionId="session-1"
        currentParticipantId={null}
        onOpenMedia={vi.fn()}
      />
    );

    expect(
      screen.getByText("Context compaction failed: Provider rejected summary")
    ).toBeInTheDocument();
  });

  it("renders restored conversation context", () => {
    const event: SandboxEvent = {
      type: "ready",
      sandboxId: "sandbox-1",
      opencodeSessionId: "ses-1",
      contextStatus: "restored",
      timestamp: 1_700_000_000,
    };

    render(
      <EventItem
        event={event}
        sessionId="session-1"
        currentParticipantId={null}
        onOpenMedia={vi.fn()}
      />
    );

    expect(screen.getByText("Conversation context restored")).toBeInTheDocument();
  });

  it("warns when conversation recovery falls back to an older checkpoint", () => {
    const event: SandboxEvent = {
      type: "ready",
      sandboxId: "sandbox-1",
      opencodeSessionId: "ses-1",
      contextStatus: "fallback",
      timestamp: 1_700_000_000,
    };

    render(
      <EventItem
        event={event}
        sessionId="session-1"
        currentParticipantId={null}
        onOpenMedia={vi.fn()}
      />
    );

    expect(
      screen.getByText(
        "Conversation restored from an older checkpoint. The latest turn may be missing."
      )
    ).toBeInTheDocument();
  });

  it("renders a terminal warning when the latest checkpoint fails", () => {
    const event: SandboxEvent = {
      type: "checkpoint",
      checkpointStatus: "failed",
      checkpointId: "cp-1",
      attemptId: "cpa-1",
      errorClass: "pointer_put",
      detail: "Current checkpoint pointer could not be stored",
      sandboxId: "sandbox-1",
      timestamp: 1_700_000_000,
    };

    render(
      <EventItem
        event={event}
        sessionId="session-1"
        currentParticipantId={null}
        onOpenMedia={vi.fn()}
      />
    );

    expect(
      screen.getByText(
        "Latest conversation changes could not be checkpointed. Recovery may lose this turn."
      )
    ).toBeInTheDocument();
  });

  it("renders permanent conversation context loss", () => {
    const event: SandboxEvent = {
      type: "context_unavailable",
      sandboxId: "sandbox-1",
      opencodeSessionId: "ses-1",
      error: "The checkpoint could not be restored",
      timestamp: 1_700_000_000,
    };

    render(
      <EventItem
        event={event}
        sessionId="session-1"
        currentParticipantId={null}
        onOpenMedia={vi.fn()}
      />
    );

    expect(
      screen.getByText("Conversation context unavailable: The checkpoint could not be restored")
    ).toBeInTheDocument();
  });

  it("shows the persisted queue position on a pending user message", () => {
    const event: SandboxEvent = {
      type: "user_message",
      content: "Run the tests next",
      messageId: "message-2",
      timestamp: 1_700_000_000,
    };

    render(
      <EventItem
        event={event}
        sessionId="session-1"
        currentParticipantId={null}
        onOpenMedia={vi.fn()}
        queuePosition={2}
      />
    );

    expect(screen.getByText("Queued #2")).toBeInTheDocument();
  });
});

describe("SessionTimeline", () => {
  it("reports completed output as viewed while the latest output is visible", async () => {
    class MockIntersectionObserver {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const { SessionTimeline } = await import("./session-timeline");
    const onLatestOutputViewed = vi.fn();
    const event: SandboxEvent = {
      type: "execution_complete",
      messageId: "message-1",
      success: true,
      sandboxId: "sandbox-1",
      timestamp: 1_700_000_000,
    };

    render(
      <SessionTimeline
        events={[event]}
        sessionId="session-1"
        currentParticipantId={null}
        isProcessing={false}
        promptQueue={[]}
        loadingHistory={false}
        showSkeleton={false}
        onLoadOlder={vi.fn()}
        onOpenMedia={vi.fn()}
        onLatestOutputViewed={onLatestOutputViewed}
      />
    );

    await waitFor(() => expect(onLatestOutputViewed).toHaveBeenCalledWith("message-1"));
  });

  it("reports completed output after the user scrolls down to it", async () => {
    class MockIntersectionObserver {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const { SessionTimeline } = await import("./session-timeline");
    const onLatestOutputViewed = vi.fn();
    const props = {
      sessionId: "session-1",
      currentParticipantId: null,
      isProcessing: false,
      promptQueue: [],
      loadingHistory: false,
      showSkeleton: false,
      onLoadOlder: vi.fn(),
      onOpenMedia: vi.fn(),
      onLatestOutputViewed,
    };
    const { container, rerender } = render(<SessionTimeline {...props} events={[]} />);
    const timeline = container.firstElementChild as HTMLDivElement;
    Object.defineProperties(timeline, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    fireEvent.scroll(timeline);

    const event: SandboxEvent = {
      type: "execution_complete",
      messageId: "message-1",
      success: true,
      sandboxId: "sandbox-1",
      timestamp: 1_700_000_000,
    };
    rerender(<SessionTimeline {...props} events={[event]} />);
    expect(onLatestOutputViewed).not.toHaveBeenCalled();

    timeline.scrollTop = 800;
    fireEvent.scroll(timeline);

    await waitFor(() => expect(onLatestOutputViewed).toHaveBeenCalledWith("message-1"));
  });
});
