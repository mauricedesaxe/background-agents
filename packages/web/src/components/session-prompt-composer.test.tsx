// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SessionPromptComposer } from "./session-prompt-composer";

expect.extend(matchers);

afterEach(cleanup);

it("offers cancellation while context compaction is active", () => {
  render(
    <SessionPromptComposer
      session={{
        id: "session-1",
        status: "active",
        artifacts: [],
        onArchive: vi.fn(),
        onUnarchive: vi.fn(),
      }}
      prompt={{
        value: "",
        isProcessing: false,
        isCompacting: true,
        inputRef: { current: null },
        onSubmit: vi.fn(),
        onChange: vi.fn(),
        onKeyDown: vi.fn(),
        onStopExecution: vi.fn(),
        onCompactContext: vi.fn(),
      }}
      model={{
        selectedModel: "openai/gpt-5.6-sol",
        reasoningEffort: undefined,
        items: [],
        onModelChange: vi.fn(),
        onReasoningEffortChange: vi.fn(),
      }}
    />
  );

  expect(screen.getByRole("button", { name: "Cancel context compaction" })).toBeInTheDocument();
});
