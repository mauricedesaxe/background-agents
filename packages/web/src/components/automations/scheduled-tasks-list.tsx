"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import type { Environment, ListScheduledTasksResponse, ScheduledTask } from "@open-inspect/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useEnvironments } from "@/hooks/use-environments";
import { formatRepoLabel } from "@/lib/repo-label";

const fetcher = async (url: string): Promise<ListScheduledTasksResponse> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Scheduled prompts could not be loaded");
  return response.json();
};

export function ScheduledTasksList() {
  const [cancelError, setCancelError] = useState<string | null>(null);
  const { environments, loading: environmentsLoading } = useEnvironments();
  const {
    data,
    error: loadError,
    isLoading,
    mutate,
  } = useSWR<ListScheduledTasksResponse>("/api/scheduled-tasks", fetcher);
  const tasks = data?.tasks ?? [];
  const waitingForEnvironmentTargets =
    environmentsLoading && tasks.some((task) => task.automation.environmentIds.length > 0);

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
      ) : isLoading || waitingForEnvironmentTargets ? (
        <p className="py-4 text-sm text-muted-foreground">Loading scheduled prompts...</p>
      ) : tasks.length === 0 ? (
        <p className="border border-border-muted px-4 py-5 text-sm text-muted-foreground">
          No scheduled prompts.
        </p>
      ) : (
        <div className="divide-y divide-border-muted border border-border-muted">
          {tasks.map((task) => (
            <ScheduledTaskRow
              key={task.automation.id}
              task={task}
              environments={environments}
              onCancel={cancel}
            />
          ))}
        </div>
      )}
      {cancelError && <p className="mt-2 text-sm text-destructive">{cancelError}</p>}
    </section>
  );
}

function ScheduledTaskRow({
  task,
  environments,
  onCancel,
}: {
  task: ScheduledTask;
  environments: Environment[];
  onCancel: (id: string) => Promise<void>;
}) {
  const run = task.invocation?.runs[0];
  const scheduledAt = task.automation.nextRunAt ?? task.invocation?.scheduledAt;
  const environmentRepositories = task.automation.environmentIds.flatMap(
    (environmentId) =>
      environments.find((environment) => environment.id === environmentId)?.repositories ?? []
  );
  const repositoryLabels = [...task.automation.repositories, ...environmentRepositories].map(
    (repository) => formatRepoLabel(repository.repoOwner, repository.repoName)
  );
  const repositories = repositoryLabels.join(", ");
  const repositoryUnavailable =
    task.automation.environmentIds.length > 0 && environmentRepositories.length === 0;
  return (
    <article className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <Dialog>
          <DialogTrigger asChild>
            <button
              type="button"
              className="block max-w-full truncate text-left text-sm font-medium text-foreground hover:underline"
              title="View full prompt"
            >
              {task.automation.name}
            </button>
          </DialogTrigger>
          <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden">
            <DialogTitle>{task.automation.name}</DialogTitle>
            <DialogDescription>
              {repositories
                ? `Scheduled for ${repositories}.`
                : repositoryUnavailable
                  ? "Scheduled repository unavailable."
                  : "Scheduled prompt details."}
            </DialogDescription>
            <div className="overflow-y-auto whitespace-pre-wrap break-words border border-border-muted bg-muted/30 p-4 text-sm text-foreground">
              {task.automation.instructions}
            </div>
          </DialogContent>
        </Dialog>
        {repositories && (
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {repositoryLabels.length === 1 ? "Repository" : "Repositories"}: {repositories}
          </p>
        )}
        {repositoryUnavailable && (
          <p className="mt-1 text-xs text-muted-foreground">Repository unavailable</p>
        )}
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
