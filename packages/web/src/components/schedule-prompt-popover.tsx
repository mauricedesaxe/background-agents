"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ClockIcon } from "@/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { resolveLocalDateTime, tomorrowMorning } from "@/lib/scheduling";

interface SchedulePromptPopoverProps {
  disabled: boolean;
  onSchedule: (instant: Date, timeZone: string) => Promise<boolean>;
}

export function SchedulePromptPopover({ disabled, onSchedule }: SchedulePromptPopoverProps) {
  const [open, setOpen] = useState(false);
  const [timeZone, setTimeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );
  const [localDateTime, setLocalDateTime] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submissionInFlight = useRef(false);
  const supportedTimeZones =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : ["UTC", timeZone];
  const timeZones = supportedTimeZones.includes(timeZone)
    ? supportedTimeZones
    : [timeZone, ...supportedTimeZones];

  const submit = async (instant: Date) => {
    if (submissionInFlight.current) return;
    if (instant.getTime() <= Date.now()) {
      setError("Choose a time in the future.");
      return;
    }
    submissionInFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const saved = await onSchedule(instant, timeZone);
      if (saved) setOpen(false);
    } finally {
      submissionInFlight.current = false;
      setSaving(false);
    }
  };

  const submitLocal = async () => {
    const resolution = resolveLocalDateTime(localDateTime, timeZone);
    if (!resolution.ok) {
      setError(
        resolution.reason === "ambiguous"
          ? "That local time occurs twice. Choose a time outside the daylight-saving overlap."
          : resolution.reason === "nonexistent"
            ? "That local time does not exist. Choose a time outside the daylight-saving gap."
            : "Enter a valid local date and time."
      );
      return;
    }
    await submit(resolution.instant);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled || saving}
          className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
          title="Schedule prompt"
          aria-label="Schedule prompt"
        >
          <ClockIcon className="w-5 h-5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-80 space-y-4">
        <div>
          <p className="font-medium text-sm">Run later</p>
          <p className="text-xs text-muted-foreground mt-1">No sandbox starts until this is due.</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => submit(new Date(Date.now() + 15 * 60_000))}
          >
            15 min
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => submit(new Date(Date.now() + 60 * 60_000))}
          >
            1 hour
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => {
              const result = tomorrowMorning(timeZone);
              if (result.ok) void submit(result.instant);
              else setError("Tomorrow morning cannot be resolved in this timezone.");
            }}
          >
            Tomorrow
          </Button>
        </div>
        <label className="block text-xs text-muted-foreground">
          Local date and time
          <input
            type="datetime-local"
            value={localDateTime}
            onChange={(event) => setLocalDateTime(event.target.value)}
            disabled={saving}
            className="mt-1 w-full border border-border bg-input px-2 py-1.5 text-sm text-foreground"
          />
        </label>
        <label className="block text-xs text-muted-foreground">
          Timezone
          <select
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
            disabled={saving}
            className="mt-1 w-full border border-border bg-input px-2 py-1.5 text-sm text-foreground"
          >
            {timeZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button
          className="w-full"
          size="sm"
          disabled={!localDateTime || saving}
          onClick={submitLocal}
        >
          {saving ? "Scheduling..." : "Schedule"}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
