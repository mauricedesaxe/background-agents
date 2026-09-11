"use client";

import { useState } from "react";
import { mutate } from "swr";
import { Button } from "@/components/ui/button";
import { ClockIcon } from "@/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { buildOnceAutomationRequest, validateOnceScheduleForm } from "@/lib/once-schedule";
import type { SessionTargetRequestFields } from "@/lib/session-target";

interface OnceSchedulePopoverProps {
  instructions: string;
  target: SessionTargetRequestFields | null;
  disabled?: boolean;
}

function datetimeLocalValue(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() + 15, 0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours()
  )}:${pad(now.getMinutes())}`;
}

/**
 * Schedule the currently typed prompt as a one-shot automation that fires
 * once at the chosen time (card 12). Sits in the main screen's input footer.
 */
export function OnceSchedulePopover({ instructions, target, disabled }: OnceSchedulePopoverProps) {
  const [open, setOpen] = useState(false);
  const [runAt, setRunAt] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const onceRunAt = runAt ? new Date(runAt).getTime() : null;
    const validationError = validateOnceScheduleForm({ instructions, onceRunAt }, Date.now());
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const response = await browserApiFetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildOnceAutomationRequest(instructions, onceRunAt as number, target)),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setError(data?.error || "Failed to schedule the run.");
        return;
      }
      mutate((key) => typeof key === "string" && key.startsWith("/api/automations?"));
      setOpen(false);
      setRunAt("");
    } catch {
      setError("Failed to schedule the run.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setError("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
          title="Schedule for later"
          aria-label="Schedule for later"
        >
          <ClockIcon className="w-4 h-4" aria-hidden="true" />
          <span className="text-xs">Schedule</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <form onSubmit={handleSubmit}>
          <p className="text-sm font-medium text-foreground">Run once, later</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Launches this prompt as a session at the chosen time, then stops.
          </p>
          <input
            type="datetime-local"
            value={runAt}
            onChange={(event) => setRunAt(event.target.value)}
            min={datetimeLocalValue()}
            className="mt-3 w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
            aria-label="Run at"
          />
          {error && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="mt-3 flex justify-end">
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting ? "Scheduling…" : "Schedule run"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
