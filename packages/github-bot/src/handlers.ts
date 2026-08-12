import {
  createSessionResponseSchema,
  escapeRegExp,
  resolveAppName,
  sendPromptResponseSchema,
} from "@open-inspect/shared";
import { signedControlPlaneFetch } from "./internal-auth";
import type {
  Env,
  PullRequestOpenedPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
} from "./types";
import type { Logger } from "./logger";
import {
  generateInstallationToken,
  postReaction,
  postIssueComment,
  checkSenderPermission,
  fetchPullRequest,
} from "./github-auth";
import {
  buildCodeReviewPrompt,
  buildIssueActionPrompt,
  buildPullRequestActionPrompt,
} from "./prompts";
import { resolveSessionTarget, type SessionTargetFields } from "./session-target";
import { getGitHubConfig, type ResolvedGitHubConfig } from "./utils/integration-config";
import { requestedReviewerPayloadSchema } from "./payload-schemas";

export type HandlerResult =
  | { outcome: "processed"; session_id: string; message_id: string; handler_action: string }
  | { outcome: "skipped"; skip_reason: string };

export function isReviewRequestedForBot(payload: unknown, botUsername: string): boolean {
  const parsed = requestedReviewerPayloadSchema.safeParse(payload);
  if (!parsed.success) return false;
  return parsed.data.requested_reviewer?.login === botUsername;
}

async function createSession(
  env: Env,
  traceId: string,
  params: {
    target: SessionTargetFields;
    title: string;
    model: string;
    reasoningEffort?: string | null;
    scmUserId: string;
  }
): Promise<string> {
  const body: Record<string, unknown> = {
    ...params.target,
    title: params.title,
    model: params.model,
  };
  if (params.reasoningEffort) {
    body.reasoningEffort = params.reasoningEffort;
  }
  const url = "https://internal/sessions";
  const bodyText = JSON.stringify(body);
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url,
    body: bodyText,
    actor: `github:${params.scmUserId}`,
    traceId,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Session creation failed: ${response.status} ${body}`);
  }
  const result = createSessionResponseSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error("Session creation failed: invalid response");
  }
  return result.data.sessionId;
}

async function sendPrompt(
  env: Env,
  traceId: string,
  sessionId: string,
  params: { content: string; authorId: string }
): Promise<string> {
  const url = `https://internal/sessions/${sessionId}/prompt`;
  const bodyText = JSON.stringify({ content: params.content, source: "github" });
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url,
    body: bodyText,
    actor: params.authorId.startsWith("github:") ? params.authorId : undefined,
    traceId,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Prompt delivery failed: ${response.status} ${body}`);
  }
  const result = sendPromptResponseSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error("Prompt delivery failed: invalid response");
  }
  return result.data.messageId;
}

type MarkdownFence = { marker: "`" | "~"; length: number };

export function extractAuthorizedCommand(body: string, botUsername: string): string | null {
  const slashCommand = /^\/open-inspect(?:\s+(.+))?$/i;
  const mention = new RegExp(`@${escapeRegExp(botUsername)}(?![\\w-])`, "i");
  let fence: MarkdownFence | null = null;
  const lines = body.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (/^(?: {4}|\t)/.test(line)) continue;
    const trimmed = line.trimStart();
    if (fence) {
      if (closesMarkdownFence(trimmed, fence)) fence = null;
      continue;
    }
    fence = openingMarkdownFence(trimmed);
    if (fence || trimmed.startsWith(">")) continue;

    const slashMatch = slashCommand.exec(trimmed);
    const slashInstruction = slashMatch
      ? [slashMatch[1] ?? "", ...authorizedContinuation(lines, index + 1)].join("\n").trim()
      : "";
    if (slashInstruction) return slashInstruction;

    const mentionMatch = mention.exec(trimmed);
    if (mentionMatch) {
      const beforeMention = trimmed.slice(0, mentionMatch.index).trimEnd();
      const afterMention = trimmed.slice(mentionMatch.index + mentionMatch[0].length).trimStart();
      const mentionInstruction = [
        [beforeMention, afterMention].filter(Boolean).join(" "),
        ...authorizedContinuation(lines, index + 1),
      ]
        .join("\n")
        .trim();
      if (mentionInstruction) return mentionInstruction;
    }
  }

  return null;
}

function authorizedContinuation(lines: string[], startIndex: number): string[] {
  let fence: MarkdownFence | null = null;
  const authorized: string[] = [];

  for (const line of lines.slice(startIndex)) {
    if (/^(?: {4}|\t)/.test(line)) continue;
    const trimmed = line.trimStart();
    if (fence) {
      if (closesMarkdownFence(trimmed, fence)) fence = null;
      continue;
    }
    fence = openingMarkdownFence(trimmed);
    if (fence || trimmed.startsWith(">")) continue;
    authorized.push(line);
  }

  return authorized;
}

function openingMarkdownFence(line: string): MarkdownFence | null {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;

  const run = match[1];
  const suffix = match[2];
  if (run[0] === "`" && suffix.includes("`")) return null;
  return { marker: run[0] as MarkdownFence["marker"], length: run.length };
}

function closesMarkdownFence(line: string, fence: MarkdownFence): boolean {
  const match = /^(`+|~+)[ \t]*$/.exec(line);
  return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length);
}

function fireAndForgetReaction(
  log: Logger,
  token: string,
  url: string,
  userAgent: string,
  meta: Record<string, unknown>
): void {
  postReaction(token, url, "eyes", userAgent).then(
    (ok) => {
      if (ok) log.debug("acknowledgment.posted", meta);
      else log.warn("acknowledgment.failed", meta);
    },
    () => log.warn("acknowledgment.failed", meta)
  );
}

type CallerGatingResult =
  | { allowed: true; ghToken: string }
  | {
      allowed: false;
      reason: "sender_not_allowed" | "sender_insufficient_permission" | "permission_check_failed";
      ghToken: string | null;
    };

async function resolveCallerGating(
  env: Env,
  config: ResolvedGitHubConfig,
  senderLogin: string,
  owner: string,
  repoName: string,
  log: Logger,
  traceId: string,
  repoFullName: string
): Promise<CallerGatingResult> {
  if (config.allowedTriggerUsers !== null) {
    if (!config.allowedTriggerUsers.some((u) => u.toLowerCase() === senderLogin.toLowerCase())) {
      log.info("handler.sender_not_allowed", { trace_id: traceId, sender: senderLogin });
      return { allowed: false, reason: "sender_not_allowed", ghToken: null };
    }
  }

  const userAgent = resolveAppName(env);
  const ghToken = await generateInstallationToken({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    installationId: env.GITHUB_APP_INSTALLATION_ID,
    userAgent,
  });

  if (config.allowedTriggerUsers === null) {
    const { hasPermission, error } = await checkSenderPermission(
      ghToken,
      owner,
      repoName,
      senderLogin,
      userAgent
    );
    if (!hasPermission) {
      const reason = error ? "permission_check_failed" : "sender_insufficient_permission";
      log.info(
        error ? "handler.permission_check_failed" : "handler.sender_insufficient_permission",
        {
          trace_id: traceId,
          sender: senderLogin,
          repo: repoFullName,
        }
      );
      return { allowed: false, reason, ghToken };
    }
  }

  return { allowed: true, ghToken };
}

async function postCommandStatus(
  env: Env,
  token: string | null,
  owner: string,
  repoName: string,
  issueNumber: number,
  body: string
): Promise<void> {
  const ghToken =
    token ??
    (await generateInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
      userAgent: resolveAppName(env),
    }));
  await postIssueComment(ghToken, owner, repoName, issueNumber, body, resolveAppName(env));
}

function withBranch(
  target: SessionTargetFields,
  branch: string,
  repoOwner: string,
  repoName: string
): SessionTargetFields {
  return "environmentId" in target
    ? { ...target, branch, branchRepository: { repoOwner, repoName } }
    : { ...target, branch };
}

export async function handleReviewRequested(
  env: Env,
  log: Logger,
  payload: ReviewRequestedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, requested_reviewer, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (requested_reviewer?.login !== env.GITHUB_BOT_USERNAME) {
    log.debug("handler.review_not_for_bot", {
      trace_id: traceId,
      requested_reviewer: requested_reviewer?.login,
    });
    return { outcome: "skipped", skip_reason: "review_not_for_bot" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken } = gating;

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  fireAndForgetReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/issues/${pr.number}/reactions`,
    resolveAppName(env),
    meta
  );

  const target = await resolveSessionTarget(env, log, {
    owner,
    repoName,
    senderLogin: sender.login,
    config,
    ghToken,
    traceId,
  });
  const sessionId = await createSession(env, traceId, {
    target,
    title: `GitHub: Review PR #${pr.number}`,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    scmUserId: String(sender.id),
  });
  log.info("session.created", { ...meta, session_id: sessionId, action: "review" });

  const prompt = buildCodeReviewPrompt({
    owner,
    repo: repoName,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.user.login,
    base: pr.base.ref,
    head: pr.head.ref,
    isPublic: !repo.private,
    codeReviewInstructions: config.codeReviewInstructions,
  });

  const messageId = await sendPrompt(env, traceId, sessionId, {
    content: prompt,
    authorId: `github:${payload.sender.id}`,
  });
  log.info("prompt.sent", {
    ...meta,
    session_id: sessionId,
    message_id: messageId,
    source: "github",
    content_length: prompt.length,
  });

  return {
    outcome: "processed",
    session_id: sessionId,
    message_id: messageId,
    handler_action: "review",
  };
}

export async function handlePullRequestOpened(
  env: Env,
  log: Logger,
  payload: PullRequestOpenedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (pr.draft) {
    log.debug("handler.draft_pr_skipped", { trace_id: traceId, pull_number: pr.number });
    return { outcome: "skipped", skip_reason: "draft_pr" };
  }

  if (pr.user.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_pr_ignored", { trace_id: traceId, pull_number: pr.number });
    return { outcome: "skipped", skip_reason: "self_pr" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  if (!config.autoReviewOnOpen) {
    log.debug("handler.auto_review_disabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "auto_review_disabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken } = gating;

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  fireAndForgetReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/issues/${pr.number}/reactions`,
    resolveAppName(env),
    meta
  );

  const target = await resolveSessionTarget(env, log, {
    owner,
    repoName,
    senderLogin: sender.login,
    config,
    ghToken,
    traceId,
  });
  const sessionId = await createSession(env, traceId, {
    target,
    title: `GitHub: Review PR #${pr.number}`,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    scmUserId: String(sender.id),
  });
  log.info("session.created", { ...meta, session_id: sessionId, action: "auto_review" });

  const prompt = buildCodeReviewPrompt({
    owner,
    repo: repoName,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.user.login,
    base: pr.base.ref,
    head: pr.head.ref,
    isPublic: !repo.private,
    codeReviewInstructions: config.codeReviewInstructions,
  });

  const messageId = await sendPrompt(env, traceId, sessionId, {
    content: prompt,
    authorId: `github:${sender.id}`,
  });
  log.info("prompt.sent", {
    ...meta,
    session_id: sessionId,
    message_id: messageId,
    source: "github",
    content_length: prompt.length,
  });

  return {
    outcome: "processed",
    session_id: sessionId,
    message_id: messageId,
    handler_action: "auto_review",
  };
}

export async function handleIssueComment(
  env: Env,
  log: Logger,
  payload: IssueCommentPayload,
  traceId: string
): Promise<HandlerResult> {
  const { issue, comment, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (sender.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_comment_ignored", { trace_id: traceId });
    return { outcome: "skipped", skip_reason: "self_comment" };
  }

  const command = extractAuthorizedCommand(comment.body, env.GITHUB_BOT_USERNAME);
  if (!command) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      issue_number: issue.number,
      sender: sender.login,
    });
    return { outcome: "skipped", skip_reason: "no_mention" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    await postCommandStatus(
      env,
      null,
      owner,
      repoName,
      issue.number,
      "Open Inspect couldn't start this command because this repository is disabled in Settings > Integrations > GitHub."
    );
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) {
    const reason =
      gating.reason === "permission_check_failed"
        ? "Open Inspect couldn't verify your repository permission. Please try again later."
        : `Open Inspect couldn't start this command because @${sender.login} is not authorized to trigger it.`;
    await postCommandStatus(env, gating.ghToken, owner, repoName, issue.number, reason);
    return { outcome: "skipped", skip_reason: gating.reason };
  }
  const { ghToken } = gating;

  const kind = issue.pull_request ? "pr" : "issue";
  const meta = {
    trace_id: traceId,
    repo: repoFullName,
    issue_number: issue.number,
    command_target: kind,
  };

  try {
    const pullRequest = issue.pull_request
      ? await fetchPullRequest(ghToken, owner, repoName, issue.number, resolveAppName(env))
      : null;
    if (pullRequest?.isCrossRepository) {
      await postCommandStatus(
        env,
        ghToken,
        owner,
        repoName,
        issue.number,
        "Open Inspect cannot safely update fork pull requests yet. Run the command on a branch in the base repository."
      );
      return { outcome: "skipped", skip_reason: "fork_pull_request" };
    }
    const resolvedTarget = await resolveSessionTarget(env, log, {
      owner,
      repoName,
      senderLogin: sender.login,
      config,
      ghToken,
      traceId,
    });
    const branch = pullRequest?.head ?? repo.default_branch;
    fireAndForgetReaction(
      log,
      ghToken,
      `https://api.github.com/repos/${owner}/${repoName}/issues/comments/${comment.id}/reactions`,
      resolveAppName(env),
      meta
    );
    const sessionId = await createSession(env, traceId, {
      target: withBranch(resolvedTarget, branch, owner, repoName),
      title: `GitHub: ${issue.pull_request ? "PR" : "Issue"} #${issue.number} command`,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      scmUserId: String(sender.id),
    });
    const handlerAction = issue.pull_request ? "pr_command" : "issue_command";
    log.info("session.created", { ...meta, session_id: sessionId, action: handlerAction });

    const prompt = pullRequest
      ? buildPullRequestActionPrompt({
          owner,
          repo: repoName,
          number: issue.number,
          title: pullRequest.title,
          body: pullRequest.body,
          author: pullRequest.author,
          base: pullRequest.base,
          head: pullRequest.head,
          headSha: pullRequest.headSha,
          headRepository: pullRequest.headRepository,
          command,
          commenter: sender.login,
          isPublic: !repo.private,
          commentActionInstructions: config.commentActionInstructions,
        })
      : buildIssueActionPrompt({
          owner,
          repo: repoName,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          command,
          commenter: sender.login,
          defaultBranch: repo.default_branch,
          isPublic: !repo.private,
          commentActionInstructions: config.commentActionInstructions,
        });

    const messageId = await sendPrompt(env, traceId, sessionId, {
      content: prompt,
      authorId: `github:${sender.id}`,
    });
    log.info("prompt.sent", {
      ...meta,
      session_id: sessionId,
      message_id: messageId,
      source: "github",
      content_length: prompt.length,
    });

    return {
      outcome: "processed",
      session_id: sessionId,
      message_id: messageId,
      handler_action: handlerAction,
    };
  } catch (error) {
    await postCommandStatus(
      env,
      ghToken,
      owner,
      repoName,
      issue.number,
      "Open Inspect accepted this command but couldn't start the session. Please try again."
    );
    throw error;
  }
}

export async function handleReviewComment(
  env: Env,
  log: Logger,
  payload: ReviewCommentPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, comment, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (sender.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_comment_ignored", { trace_id: traceId });
    return { outcome: "skipped", skip_reason: "self_comment" };
  }

  const command = extractAuthorizedCommand(comment.body, env.GITHUB_BOT_USERNAME);
  if (!command) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      pull_number: pr.number,
      sender: sender.login,
    });
    return { outcome: "skipped", skip_reason: "no_mention" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    await postCommandStatus(
      env,
      null,
      owner,
      repoName,
      pr.number,
      "Open Inspect couldn't start this command because this repository is disabled in Settings > Integrations > GitHub."
    );
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) {
    const reason =
      gating.reason === "permission_check_failed"
        ? "Open Inspect couldn't verify your repository permission. Please try again later."
        : `Open Inspect couldn't start this command because @${sender.login} is not authorized to trigger it.`;
    await postCommandStatus(env, gating.ghToken, owner, repoName, pr.number, reason);
    return { outcome: "skipped", skip_reason: gating.reason };
  }
  const { ghToken } = gating;

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };

  try {
    const pullRequest = await fetchPullRequest(
      ghToken,
      owner,
      repoName,
      pr.number,
      resolveAppName(env)
    );
    if (pullRequest.isCrossRepository) {
      await postCommandStatus(
        env,
        ghToken,
        owner,
        repoName,
        pr.number,
        "Open Inspect cannot safely update fork pull requests yet. Run the command on a branch in the base repository."
      );
      return { outcome: "skipped", skip_reason: "fork_pull_request" };
    }
    fireAndForgetReaction(
      log,
      ghToken,
      `https://api.github.com/repos/${owner}/${repoName}/pulls/comments/${comment.id}/reactions`,
      resolveAppName(env),
      meta
    );
    const target = withBranch(
      await resolveSessionTarget(env, log, {
        owner,
        repoName,
        senderLogin: sender.login,
        config,
        ghToken,
        traceId,
      }),
      pullRequest.head,
      owner,
      repoName
    );
    const sessionId = await createSession(env, traceId, {
      target,
      title: `GitHub: PR #${pr.number} review comment`,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      scmUserId: String(sender.id),
    });
    log.info("session.created", { ...meta, session_id: sessionId, action: "review_comment" });

    const prompt = buildPullRequestActionPrompt({
      owner,
      repo: repoName,
      number: pr.number,
      title: pullRequest.title,
      body: pullRequest.body,
      author: pullRequest.author,
      base: pullRequest.base,
      head: pullRequest.head,
      headSha: pullRequest.headSha,
      headRepository: pullRequest.headRepository,
      command,
      commenter: sender.login,
      isPublic: !repo.private,
      filePath: comment.path,
      diffHunk: comment.diff_hunk,
      commentId: comment.id,
      commentActionInstructions: config.commentActionInstructions,
    });

    const messageId = await sendPrompt(env, traceId, sessionId, {
      content: prompt,
      authorId: `github:${sender.id}`,
    });
    log.info("prompt.sent", {
      ...meta,
      session_id: sessionId,
      message_id: messageId,
      source: "github",
      content_length: prompt.length,
    });

    return {
      outcome: "processed",
      session_id: sessionId,
      message_id: messageId,
      handler_action: "review_comment",
    };
  } catch (error) {
    await postCommandStatus(
      env,
      ghToken,
      owner,
      repoName,
      pr.number,
      "Open Inspect accepted this command but couldn't start the session. Please try again."
    );
    throw error;
  }
}
