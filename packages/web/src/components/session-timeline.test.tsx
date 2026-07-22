// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SandboxEvent } from "@/types/session";
import { EventItem } from "./session-timeline";

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

describe("EventItem", () => {
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
});
