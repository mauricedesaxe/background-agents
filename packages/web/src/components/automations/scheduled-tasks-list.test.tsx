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

const { mutate, useSWR, useEnvironments } = vi.hoisted(() => ({
  mutate: vi.fn(),
  useSWR: vi.fn(),
  useEnvironments: vi.fn(),
}));

vi.mock("swr", () => ({ default: useSWR }));
vi.mock("@/hooks/use-environments", () => ({ useEnvironments }));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

const task: ScheduledTask = {
  automation: {
    id: "task-1",
    name: "Inspect deployment",
    instructions: "Inspect deployment\n\nCheck the production logs and report any regressions.",
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
    repositories: [
      {
        repoOwner: "open-inspect",
        repoName: "background-agents",
        repoId: 1,
        baseBranch: "main",
      },
    ],
    environmentIds: [],
  },
  state: "scheduled",
  invocation: null,
};

describe("ScheduledTasksList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEnvironments.mockReturnValue({
      environments: [
        {
          id: "env_1",
          name: "Production",
          description: null,
          prebuildEnabled: true,
          createdAt: 1,
          updatedAt: 1,
          repositories: [
            {
              repoOwner: "open-inspect",
              repoName: "control-plane",
              repoId: 2,
              baseBranch: "main",
            },
          ],
        },
      ],
      loading: false,
    });
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

  it("shows the repository and opens the full prompt", async () => {
    render(<ScheduledTasksList />);

    expect(screen.getByText("Repository: open-inspect/background-agents")).toBeInTheDocument();
    expect(
      screen.queryByText("Check the production logs and report any regressions.")
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Inspect deployment" }));

    expect(
      await screen.findByText(/Check the production logs and report any regressions\./)
    ).toBeInTheDocument();
    expect(screen.getByText("Scheduled for open-inspect/background-agents.")).toBeInTheDocument();
  });

  it("shows repositories from an environment target", () => {
    useSWR.mockReturnValue({
      data: {
        tasks: [
          {
            ...task,
            automation: {
              ...task.automation,
              repositories: [],
              environmentIds: ["env_1"],
            },
          },
        ],
      },
      error: null,
      isLoading: false,
      mutate,
    });

    render(<ScheduledTasksList />);

    expect(screen.getByText("Repository: open-inspect/control-plane")).toBeInTheDocument();
  });

  it("waits for environment repositories before showing their prompts", () => {
    useEnvironments.mockReturnValue({ environments: [], loading: true });
    useSWR.mockReturnValue({
      data: {
        tasks: [
          {
            ...task,
            automation: {
              ...task.automation,
              repositories: [],
              environmentIds: ["env_1"],
            },
          },
        ],
      },
      error: null,
      isLoading: false,
      mutate,
    });

    render(<ScheduledTasksList />);

    expect(screen.getByText("Loading scheduled prompts...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inspect deployment" })).not.toBeInTheDocument();
  });

  it("shows an unavailable repository when an environment cannot be resolved", () => {
    useEnvironments.mockReturnValue({ environments: [], loading: false });
    useSWR.mockReturnValue({
      data: {
        tasks: [
          {
            ...task,
            automation: {
              ...task.automation,
              repositories: [],
              environmentIds: ["env_missing"],
            },
          },
        ],
      },
      error: null,
      isLoading: false,
      mutate,
    });

    render(<ScheduledTasksList />);

    expect(screen.getByText("Repository unavailable")).toBeInTheDocument();
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
