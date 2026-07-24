import {
  automationRepositoriesInputSchema,
  getValidModelOrDefault,
  isEnvironmentId,
  isValidModel,
  isValidReasoningEffort,
  MAX_AUTOMATION_REPOSITORIES,
  type CreateScheduledTaskRequest,
  type ScheduledTask,
} from "@open-inspect/shared";
import { z } from "zod";
import { generateId } from "../auth/crypto";
import {
  AutomationStore,
  toAutomation,
  type AutomationRepositoryInsert,
  type AutomationRow,
} from "../db/automation-store";
import { EnvironmentStore } from "../db/environments";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { error, json, parseJsonBody, parsePattern, resolveRepoOrError } from "./shared";
import type { RequestContext, Route } from "./shared";

const MAX_INSTRUCTIONS_LENGTH = 15_000;
const MAX_TASK_NAME_LENGTH = 80;
const executionInstantSchema = z.string().datetime({ offset: true });
const logger = createLogger("router:scheduled-tasks");

interface ScheduledTaskIdentity {
  ownerUserId: string;
  participantUserId: string;
}

async function handleCreateScheduledTask(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<CreateScheduledTaskRequest & ScheduledTaskIdentity>(request);
  if (body instanceof Response) return body;
  if (!body.ownerUserId || !body.participantUserId) return error("Owner identity is required", 400);
  if (!body.instructions?.trim()) return error("instructions is required", 400);
  if (body.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    return error(`instructions must be at most ${MAX_INSTRUCTIONS_LENGTH} characters`, 400);
  }
  if (!executionInstantSchema.safeParse(body.executeAt).success) {
    return error("executeAt must be an ISO-8601 instant with an explicit offset", 400);
  }
  const executeAt = Date.parse(body.executeAt);
  if (!Number.isFinite(executeAt) || executeAt <= Date.now()) {
    return error("executeAt must be a valid future instant", 400);
  }
  if (!body.scheduleTz || !isValidTimezone(body.scheduleTz)) {
    return error("scheduleTz must be a valid IANA timezone", 400);
  }
  if (body.model && !isValidModel(body.model)) return error("Invalid model", 400);
  const model = getValidModelOrDefault(body.model);
  const reasoningEffort = body.reasoningEffort ?? null;
  if (reasoningEffort !== null && !isValidReasoningEffort(model, reasoningEffort)) {
    return error("Invalid reasoning effort for selected model", 400);
  }

  const parsedRepositories = automationRepositoriesInputSchema.safeParse(body.repositories ?? []);
  if (!parsedRepositories.success) return error("Invalid repository selection", 400);
  const environmentIds = body.environmentIds ?? [];
  if (
    !Array.isArray(environmentIds) ||
    environmentIds.some((id) => typeof id !== "string" || !isEnvironmentId(id)) ||
    new Set(environmentIds).size !== environmentIds.length
  ) {
    return error("environmentIds must contain unique environment ids", 400);
  }
  if (parsedRepositories.data.length + environmentIds.length > MAX_AUTOMATION_REPOSITORIES) {
    return error(`At most ${MAX_AUTOMATION_REPOSITORIES} targets are allowed`, 400);
  }
  if (environmentIds.length > 1 || (environmentIds.length > 0 && parsedRepositories.data.length)) {
    return error("A scheduled prompt must target one environment or one repository set", 400);
  }

  const environmentStore = new EnvironmentStore(ctx.db);
  const environments = await Promise.all(environmentIds.map((id) => environmentStore.getById(id)));
  const missingEnvironment = environmentIds.find((_, index) => !environments[index]);
  if (missingEnvironment) return error(`Environment not found: ${missingEnvironment}`, 400);

  const repositories: AutomationRepositoryInsert[] = [];
  for (const repository of parsedRepositories.data) {
    const resolved = await resolveRepoOrError(
      env,
      repository.repoOwner,
      repository.repoName,
      ctx,
      logger
    );
    repositories.push({
      repo_owner: repository.repoOwner,
      repo_name: repository.repoName,
      repo_id: resolved.repoId,
      base_branch: repository.baseBranch ?? resolved.defaultBranch,
    });
  }

  const id = generateId();
  const now = Date.now();
  const row: AutomationRow = {
    id,
    name: taskName(body.instructions),
    instructions: body.instructions,
    trigger_type: "once",
    schedule_cron: null,
    schedule_tz: body.scheduleTz,
    model,
    reasoning_effort: reasoningEffort,
    enabled: 1,
    next_run_at: executeAt,
    consecutive_failures: 0,
    created_by: body.participantUserId,
    user_id: body.ownerUserId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
  };
  const store = new AutomationStore(ctx.db);
  if (executeAt <= Date.now()) {
    return error("executeAt must still be in the future after target resolution", 400);
  }
  if (!(await store.insertOnceIfFuture(row, repositories, environmentIds))) {
    return error("executeAt must still be in the future when persisted", 400);
  }
  return json({ task: await scheduledTaskView(store, row) }, 201);
}

async function handleListScheduledTasks(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const ownerUserId = new URL(request.url).searchParams.get("ownerUserId");
  if (!ownerUserId) return error("ownerUserId is required", 400);
  const store = new AutomationStore(ctx.db);
  const rows = await store.listOnceForOwner(ownerUserId);
  return json({ tasks: await Promise.all(rows.map((row) => scheduledTaskView(store, row))) });
}

async function handleGetScheduledTask(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const ownerUserId = new URL(request.url).searchParams.get("ownerUserId");
  const id = match.groups?.id;
  if (!ownerUserId || !id) return error("Task and owner are required", 400);
  const store = new AutomationStore(ctx.db);
  const row = await store.getByIdForOwner(id, ownerUserId);
  if (!row || row.trigger_type !== "once") return error("Scheduled task not found", 404);
  return json({ task: await scheduledTaskView(store, row) });
}

async function handleCancelScheduledTask(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<{ ownerUserId?: string }>(request);
  if (body instanceof Response) return body;
  const id = match.groups?.id;
  if (!body.ownerUserId || !id) return error("Task and owner are required", 400);
  const store = new AutomationStore(ctx.db);
  const row = await store.getByIdForOwner(id, body.ownerUserId);
  if (!row || row.trigger_type !== "once") return error("Scheduled task not found", 404);
  if (!(await store.cancelOnce(id, body.ownerUserId))) {
    const current = await store.getByIdForOwner(id, body.ownerUserId);
    if (!current) return error("Scheduled task not found", 404);
    return json(
      {
        error: "Scheduled task has already started or was cancelled",
        task: await scheduledTaskView(store, current),
      },
      409
    );
  }
  return json({ task: await scheduledTaskView(store, (await store.getById(id))!) });
}

async function scheduledTaskView(
  store: AutomationStore,
  row: AutomationRow
): Promise<ScheduledTask> {
  const [repositories, environments, invocation] = await Promise.all([
    store.getRepositoriesForAutomation(row.id),
    store.getEnvironmentsForAutomation(row.id),
    store.getLatestInvocation(row.id),
  ]);
  return {
    automation: toAutomation(row, repositories, environments),
    state: invocation ? invocation.status : row.enabled === 1 ? "scheduled" : "cancelled",
    invocation,
  };
}

function taskName(instructions: string): string {
  const summary = instructions.trim().replace(/\s+/g, " ");
  return summary.length <= MAX_TASK_NAME_LENGTH
    ? summary
    : `${summary.slice(0, MAX_TASK_NAME_LENGTH - 3)}...`;
}

function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const scheduledTaskRoutes: Route[] = [
  { method: "POST", pattern: parsePattern("/scheduled-tasks"), handler: handleCreateScheduledTask },
  { method: "GET", pattern: parsePattern("/scheduled-tasks"), handler: handleListScheduledTasks },
  {
    method: "GET",
    pattern: parsePattern("/scheduled-tasks/:id"),
    handler: handleGetScheduledTask,
  },
  {
    method: "POST",
    pattern: parsePattern("/scheduled-tasks/:id/cancel"),
    handler: handleCancelScheduledTask,
  },
];
