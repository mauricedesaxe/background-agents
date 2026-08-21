/**
 * One-shot ("once") scheduled-prompt routes. A scheduled task is a
 * `trigger_type: "once"` automation that fires a single time at `executeAt` and
 * then disables itself (the scheduler owns the replay-safe firing). Identity and
 * target resolution mirror the automation-create path.
 */

import {
  getValidModelOrDefault,
  isValidModel,
  isValidReasoningEffort,
} from "@open-inspect/shared/models";
import {
  automationExecutionModeSchema,
  automationRepositoriesInputSchema,
  MAX_AUTOMATION_REPOSITORIES,
} from "@open-inspect/shared/types/automations";
import type {
  CreateScheduledTaskRequest,
  ScheduledTask,
  ScheduledTaskState,
} from "@open-inspect/shared/types/automations";
import { isEnvironmentId } from "@open-inspect/shared/types/environments";
import { z } from "zod";
import { generateId } from "../auth/crypto";
import { applyIdentityEnforcement, resolveCanonicalUserId } from "../auth/identity-enforcement";
import {
  AutomationStore,
  toAutomation,
  type AutomationRepositoryInsert,
  type AutomationRow,
} from "../db/automation-store";
import { EnvironmentStore } from "../db/environments";
import { UserStore } from "../db/user-store";
import { createLogger } from "../logger";
import type { Env } from "../types";
import {
  defineRoutes,
  error,
  GITHUB_USER_OR_SERVICE_ROUTE,
  json,
  parseJsonBody,
  parsePattern,
  resolveRepoOrError,
  type RequestContext,
  type Route,
} from "./shared";

const MAX_INSTRUCTIONS_LENGTH = 15_000;
const MAX_TASK_NAME_LENGTH = 80;
const executionInstantSchema = z.string().datetime({ offset: true });
const logger = createLogger("router:scheduled-tasks");

async function handleCreateScheduledTask(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<
    CreateScheduledTaskRequest & {
      actorDisplayName?: string;
      actorEmail?: string;
      actorAvatarUrl?: string;
    }
  >(request);
  if (body instanceof Response) return body;

  const enforcement = applyIdentityEnforcement(ctx, "automation-create", body);
  if (enforcement.rejection) return enforcement.rejection;
  const enforced = enforcement.enforced;

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

  const executionMode = automationExecutionModeSchema.safeParse(body.executionMode ?? "fanout");
  if (!executionMode.success) return error("executionMode must be fanout or shared_workspace", 400);
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
  if (executionMode.data === "shared_workspace") {
    if (environmentIds.length > 0)
      return error("Shared workspace mode cannot target environments", 400);
    if (parsedRepositories.data.length < 2) {
      return error("Shared workspace mode requires at least two repositories", 400);
    }
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

  const resolution = await resolveCanonicalUserId(new UserStore(ctx.db), ctx, enforced, {
    displayName: body.actorDisplayName,
    email: body.actorEmail,
    avatarUrl: body.actorAvatarUrl,
  });
  if (resolution instanceof Response) return resolution;

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
    created_by: enforced.participantUserId,
    user_id: resolution.userId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
    execution_mode: executionMode.data,
  };
  const store = new AutomationStore(ctx.db);
  if (!(await store.insertOnceIfFuture(row, repositories, environmentIds))) {
    return error("executeAt must still be in the future when persisted", 400);
  }
  return json({ task: await scheduledTaskView(store, row) }, 201);
}

async function handleListScheduledTasks(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const owner = await requireOwnerUserId(ctx);
  if (owner instanceof Response) return owner;
  const store = new AutomationStore(ctx.db);
  const rows = await store.listOnceForOwner(owner);
  return json({ tasks: await Promise.all(rows.map((row) => scheduledTaskView(store, row))) });
}

async function handleGetScheduledTask(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const owner = await requireOwnerUserId(ctx);
  if (owner instanceof Response) return owner;
  const id = match.groups?.id;
  if (!id) return error("Task id is required", 400);
  const store = new AutomationStore(ctx.db);
  const row = await store.getByIdForOwner(id, owner);
  if (!row || row.trigger_type !== "once") return error("Scheduled task not found", 404);
  return json({ task: await scheduledTaskView(store, row) });
}

async function handleCancelScheduledTask(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const owner = await requireOwnerUserId(ctx);
  if (owner instanceof Response) return owner;
  const id = match.groups?.id;
  if (!id) return error("Task id is required", 400);
  const store = new AutomationStore(ctx.db);
  const row = await store.getByIdForOwner(id, owner);
  if (!row || row.trigger_type !== "once") return error("Scheduled task not found", 404);
  if (!(await store.cancelOnce(id, owner))) {
    const current = await store.getByIdForOwner(id, owner);
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

/**
 * Resolve the owning user from the verified principal — the same canonical id
 * an automation's `user_id` carries — so a task lists/reads/cancels only its
 * owner's rows.
 */
async function requireOwnerUserId(ctx: RequestContext): Promise<string | Response> {
  const enforcement = applyIdentityEnforcement(ctx, "automation-create", {});
  if (enforcement.rejection) return enforcement.rejection;
  const resolution = await resolveCanonicalUserId(
    new UserStore(ctx.db),
    ctx,
    enforcement.enforced,
    {}
  );
  if (resolution instanceof Response) return resolution;
  return resolution.userId;
}

async function scheduledTaskView(
  store: AutomationStore,
  row: AutomationRow
): Promise<ScheduledTask> {
  const [repositories, environments, latest] = await Promise.all([
    store.getRepositoriesForAutomation(row.id),
    store.getEnvironmentsForAutomation(row.id),
    store.listInvocations(row.id, { limit: 1, offset: 0 }),
  ]);
  const invocation = latest.invocations[0] ?? null;
  const state: ScheduledTaskState = invocation
    ? invocation.status
    : row.enabled === 1
      ? "scheduled"
      : "cancelled";
  return { automation: toAutomation(row, repositories, environments), state, invocation };
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

export const scheduledTaskRoutes: Route[] = defineRoutes(GITHUB_USER_OR_SERVICE_ROUTE, [
  { method: "POST", pattern: parsePattern("/scheduled-tasks"), handler: handleCreateScheduledTask },
  { method: "GET", pattern: parsePattern("/scheduled-tasks"), handler: handleListScheduledTasks },
  { method: "GET", pattern: parsePattern("/scheduled-tasks/:id"), handler: handleGetScheduledTask },
  {
    method: "POST",
    pattern: parsePattern("/scheduled-tasks/:id/cancel"),
    handler: handleCancelScheduledTask,
  },
]);
