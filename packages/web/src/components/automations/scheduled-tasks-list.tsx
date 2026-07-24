"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import type { ListScheduledTasksResponse, ScheduledTask } from "@open-inspect/shared";
import { Button } from "@/components/ui/button";

const fetcher = async (url: string): Promise<ListScheduledTasksResponse> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Scheduled prompts could not be loaded");
  return response.json();
};

export function ScheduledTasksList() {
  const [cancelError, setCancelError] = useState<string | null>(null);
  const {
    data,
    error: loadError,
    isLoading,
    mutate,
  } = useSWR<ListScheduledTasksResponse>("/api/scheduled-tasks", fetcher);
  const tasks = data?.tasks ?? [];

  const cancel = async (id: string) => {
    setCancelError(null);
    try {
      const response = await fetch(`/api/scheduled-tasks/${id}/cancel`, { method: "POST" });
      if (!response.ok && response.status !== 409) {
        throw new Error("Scheduled prompt could not be cancelled");
      }
      await mutate();
    } catch (error) {
      setCancelError(
        error instanceof Error ? error.message : "Scheduled prompt could not be cancelled"
      );
    }
  };

  return (
    <section className="mb-10" aria-labelledby="scheduled-tasks-heading">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <div>
          <h2 id="scheduled-tasks-heading" className="text-lg font-medium text-foreground">
            Scheduled prompts
          </h2>
          <p className="text-sm text-muted-foreground">One-shot prompts waiting to start.</p>
        </div>
      </div>
      {loadError ? (
        <p className="border border-destructive/40 px-4 py-5 text-sm text-destructive">
          Scheduled prompts could not be loaded.
        </p>
      ) : isLoading ? (
        <p className="py-4 text-sm text-muted-foreground">Loading scheduled prompts...</p>
      ) : tasks.length === 0 ? (
        <p className="border border-border-muted px-4 py-5 text-sm text-muted-foreground">
          No scheduled prompts.
        </p>
      ) : (
        <div className="divide-y divide-border-muted border border-border-muted">
          {tasks.map((task) => (
            <ScheduledTaskRow key={task.automation.id} task={task} onCancel={cancel} />
          ))}
        </div>
      )}
      {cancelError && <p className="mt-2 text-sm text-destructive">{cancelError}</p>}
    </section>
  );
}

function ScheduledTaskRow({
  task,
  onCancel,
}: {
  task: ScheduledTask;
  onCancel: (id: string) => Promise<void>;
}) {
  const run = task.invocation?.runs[0];
  const scheduledAt = task.automation.nextRunAt ?? task.invocation?.scheduledAt;
  return (
    <article className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{task.automation.name}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {task.state}
          {scheduledAt ? ` · due ${formatDate(scheduledAt, task.automation.scheduleTz)}` : ""}
          {run?.startedAt
            ? ` · started ${formatDate(run.startedAt, task.automation.scheduleTz)}`
            : ""}
        </p>
        {run?.failureReason && <p className="mt-1 text-xs text-destructive">{run.failureReason}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {run?.sessionId && run.sessionTitle && (
          <Button variant="outline" size="sm" asChild>
            <Link href={`/session/${run.sessionId}`}>Open session</Link>
          </Button>
        )}
        {task.state === "scheduled" && (
          <Button variant="outline" size="sm" onClick={() => onCancel(task.automation.id)}>
            Cancel
          </Button>
        )}
      </div>
    </article>
  );
}

function formatDate(timestamp: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(timestamp);
}
