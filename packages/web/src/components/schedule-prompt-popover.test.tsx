// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SchedulePromptPopover } from "./schedule-prompt-popover";

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

function openPopover() {
  fireEvent.click(screen.getByRole("button", { name: "Schedule prompt" }));
}

describe("SchedulePromptPopover", () => {
  it("schedules a quick 15-minute launch with a future instant and a timezone", async () => {
    const onSchedule = vi.fn().mockResolvedValue(true);
    render(<SchedulePromptPopover disabled={false} onSchedule={onSchedule} />);

    openPopover();
    fireEvent.click(await screen.findByRole("button", { name: "15 min" }));

    await waitFor(() => expect(onSchedule).toHaveBeenCalledTimes(1));
    const [instant, timeZone] = onSchedule.mock.calls[0]!;
    expect(instant).toBeInstanceOf(Date);
    expect((instant as Date).getTime()).toBeGreaterThan(Date.now());
    expect(typeof timeZone).toBe("string");
    expect((timeZone as string).length).toBeGreaterThan(0);
  });

  it("rejects a chosen local time in the past without calling onSchedule", async () => {
    const onSchedule = vi.fn().mockResolvedValue(true);
    render(<SchedulePromptPopover disabled={false} onSchedule={onSchedule} />);

    openPopover();
    const input = await screen.findByLabelText(/Local date and time/i);
    fireEvent.change(input, { target: { value: "2000-01-01T09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    await screen.findByText("Choose a time in the future.");
    expect(onSchedule).not.toHaveBeenCalled();
  });

  it("does not open while disabled", () => {
    const onSchedule = vi.fn().mockResolvedValue(true);
    render(<SchedulePromptPopover disabled onSchedule={onSchedule} />);

    openPopover();
    expect(screen.queryByRole("button", { name: "15 min" })).not.toBeInTheDocument();
  });
});
