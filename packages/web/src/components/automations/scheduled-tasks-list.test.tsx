// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ComponentProps } from "react";
import type { ScheduledTask } from "@open-inspect/shared";
import { ScheduledTasksList } from "./scheduled-tasks-list";

expect.extend(matchers);
afterEach(cleanup);

const { mutate, useSWR } = vi.hoisted(() => ({ mutate: vi.fn(), useSWR: vi.fn() }));

vi.mock("swr", () => ({ default: useSWR }));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

const task: ScheduledTask = {
  automation: {
    id: "task-1",
    name: "Inspect deployment",
    instructions: "Inspect deployment",
    triggerType: "once",
    scheduleCron: null,
    scheduleTz: "UTC",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    enabled: true,
    nextRunAt: Date.parse("2030-01-01T10:00:00Z"),
    consecutiveFailures: 0,
    createdBy: "user-1",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    eventType: null,
    triggerConfig: null,
    repositories: [],
    environmentIds: [],
  },
  state: "scheduled",
  invocation: null,
};

describe("ScheduledTasksList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSWR.mockReturnValue({ data: { tasks: [task] }, error: null, isLoading: false, mutate });
  });

  it("shows list failures instead of an empty state", () => {
    useSWR.mockReturnValue({
      data: undefined,
      error: new Error("failed"),
      isLoading: false,
      mutate,
    });

    render(<ScheduledTasksList />);

    expect(screen.getByText("Scheduled prompts could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("No scheduled prompts.")).not.toBeInTheDocument();
  });

  it("shows cancellation failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    render(<ScheduledTasksList />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.getByText("Scheduled prompt could not be cancelled")).toBeInTheDocument()
    );
    expect(mutate).not.toHaveBeenCalled();
  });

  it("refreshes when execution wins the cancellation race", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 409 })));
    render(<ScheduledTasksList />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(screen.queryByText("Scheduled prompt could not be cancelled")).not.toBeInTheDocument();
  });
});
