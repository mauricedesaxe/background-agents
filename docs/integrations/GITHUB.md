# GitHub Integration

Open-Inspect's GitHub integration lets your team start agent work from issues and pull requests. The
GitHub Bot can automatically review new PRs and respond to `/open-inspect` commands or full bot
mentions.

This guide is for people using the GitHub integration day to day. If you are installing the GitHub
App or deploying the bot worker, start with
[Create GitHub App](../GETTING_STARTED.md#step-3-create-github-app) and
[Complete GitHub Bot Setup](../GETTING_STARTED.md#step-7c-complete-github-bot-setup-if-using-github-bot).

---

## Quick Start

1. Make sure the GitHub App is installed on the repository.
2. To get an automatic review, open a non-draft PR in a repository where auto-review is enabled.
3. To ask for work on an issue or PR, start a comment line with the short command:
   ```text
   /open-inspect investigate why the checkout test is failing
   ```
4. The full `@my-app[bot]` mention remains supported when you know it. GitHub may not autocomplete
   the App bot account.
5. For line-specific discussion, use the command in an inline PR review comment.
6. Watch for the eyes reaction, which means the bot accepted the request.
7. Open the Open-Inspect web app to watch the full session.

---

## Supported Workflows

| Workflow                  | How it works                                                         |
| ------------------------- | -------------------------------------------------------------------- |
| Auto-review new PRs       | Review non-draft PRs when they are opened, if auto-review is enabled |
| Investigate an issue      | Run `/open-inspect investigate this bug` on an issue                 |
| Implement an issue        | Ask the agent to implement it and open a linked PR                   |
| Respond to PR comments    | Run `/open-inspect <instruction>` in a PR conversation               |
| Respond to review threads | Run the command in an inline review comment                          |
| Post back to GitHub       | Submit a PR review, issue result, thread reply, or PR summary        |
| Customize behavior        | Set repository scope, trigger users, models, and custom instructions |

---

## Automatic PR Reviews

### When It Runs

When **Auto-review new PRs** is enabled, Open-Inspect starts a review session for newly opened,
non-draft PRs in enabled repositories. The agent inspects the PR diff and posts a GitHub review.

### When It Skips

Auto-review is skipped when:

- The PR is a draft
- The PR was opened by the GitHub App bot itself
- The repository is outside the configured GitHub Bot scope
- The PR opener is not allowed to trigger the bot
- Auto-review is disabled globally or for that repository

Converting a draft PR to ready for review does not start the same auto-review path. If you need a
follow-up after a draft becomes ready, mention the bot in a PR comment.

### What It Posts

The agent can submit a general review comment, approve the PR, request changes, or add inline review
comments when useful.

---

## Comment Commands

### PR Conversation Comments

Start a PR conversation comment with `/open-inspect` to ask for analysis, implementation, or a
GitHub reply:

```text
/open-inspect can you explain why this retry path is failing?
```

The full bot mention is a compatible trigger. Open-Inspect removes either trigger before sending the
authorized instruction to the agent.

### Issues

Issue commands start from the repository default branch. Investigation requests post findings
without changing code. Implementation requests can create a branch through the managed
`create-pull-request` tool and link the resulting PR on the issue. They do not close the issue.

### Inline Review Threads

When you run the command in a PR review thread, Open-Inspect includes the file path and diff context
from that thread. The agent can reply directly to the review thread and can also post a summary
comment on the PR.

### Current Branch Behavior

PR comment sessions start from the PR head branch, so implementation requests can update the
existing PR. Commands on pull requests from forks receive a visible skip response because the
sandbox cannot safely update a fork head through the base repository checkout.

Each accepted GitHub webhook starts a new Open-Inspect session. GitHub comments do not continue an
existing session the way Slack thread replies do. The agent still reads the current PR conversation
when it needs context.

Commands must begin a non-quoted comment line. Quoted examples, fenced code blocks, mid-sentence
`/open-inspect` text, edited comments, and comments from the bot itself are ignored.

---

## What You See

### Acknowledgment

When a GitHub request is accepted, the bot adds an eyes reaction. That reaction is best-effort; if
GitHub rejects the reaction, the session can still start.

### GitHub Output

For auto-review workflows, the agent posts the review result back to the PR. Depending on what it
finds, that may be a general review comment, an approval, a request for changes, or inline review
comments.

For comment-command workflows, the agent posts an issue or PR comment summarizing its response. If
the request came from an inline review thread, the agent may also reply in that thread.

GitHub does not receive the same managed completion message that Slack receives. After the initial
eyes reaction, GitHub-facing output is written by the agent from inside the session. Use the
Open-Inspect web app to watch live progress, inspect logs, or see artifacts.

---

## Settings

Open the web app and go to **Settings > Integrations > GitHub** to configure the GitHub Bot.

### Defaults and Scope

| Setting               | What it controls                                                                      |
| --------------------- | ------------------------------------------------------------------------------------- |
| Auto-review new PRs   | Whether new non-draft PRs should be reviewed automatically                            |
| Repository Scope      | Whether the bot responds in all accessible repositories or only selected repositories |
| Allowed Trigger Users | Who can trigger the bot from GitHub                                                   |

If no GitHub Bot settings are configured, Open-Inspect uses permissive defaults: all repositories
available to the GitHub App are in scope, auto-review is enabled, and users with write, maintain, or
admin access to the repository can trigger the bot.

If repository scope is set to **Selected repositories** and no repositories are selected, direct
GitHub Bot workflows are disabled. If **Only specific users** is selected and the user list is
empty, no one can trigger direct bot workflows for that scope.

These settings do not gate GitHub event automations. Automations are matched separately by their
repository, event type, enabled state, and trigger conditions.

### Models and Instructions

| Setting                     | What it controls                                                          |
| --------------------------- | ------------------------------------------------------------------------- |
| Model and reasoning effort  | Model and reasoning depth for GitHub-started sessions, when configured    |
| Code Review Instructions    | Extra guidance appended to PR review prompts                              |
| Comment Action Instructions | Extra guidance appended to issue and PR command prompts                   |
| Repository Overrides        | Per-repository overrides for model, reasoning, instructions, and behavior |

Repository overrides take priority over global defaults for the repository they apply to. The web UI
currently exposes model and reasoning settings on repository overrides. If global model or reasoning
defaults exist in integration settings, GitHub-started sessions honor them. If neither a repository
override nor global default sets a model, sessions use the deployment default model.

---

## Admin and Safety Notes

### Access Boundaries

- Repository access is deployment-scoped through the configured GitHub App installation. To restrict
  what Open-Inspect can access, install the GitHub App only on intended repositories and use
  **Repository Scope** for an additional bot-level filter.
- The same GitHub App is used for OAuth and repository access. GitHub App credentials and webhook
  secrets stay server-side.
- By default, trigger access is checked against GitHub repository permission and requires write,
  maintain, or admin access. If you configure **Only specific users**, that list becomes the trigger
  gate for the configured scope.

### Bot Behavior

- Auto-review skips draft PRs and PRs opened by the GitHub App bot. Manual commands are still
  evaluated through the normal repository and user gates.
- The bot ignores bot-authored comments and comments without a valid command trigger.
- If the bot cannot load its GitHub integration settings, it fails closed and does not start direct
  bot sessions.

### Prompt Safety

- Initial prompts separate the authorized command from untrusted repository context. PR and issue
  titles, descriptions, branches, authors, file locations, and diffs cannot override the command.
- Webhooks are verified before Open-Inspect acts on them. Duplicate webhook deliveries are
  deduplicated so GitHub retries do not normally create duplicate direct bot sessions.

---

## Troubleshooting

### The bot does not respond to a PR

Check that the GitHub App is installed on the repository and that the GitHub Bot worker is enabled.
Then confirm the webhook URL, webhook secret, subscribed events, and `github_bot_username` in
[Complete GitHub Bot Setup](../GETTING_STARTED.md#step-7c-complete-github-bot-setup-if-using-github-bot).

Also check **Settings > Integrations > GitHub**. For direct GitHub Bot workflows, the repository may
be outside the selected repository scope, or the triggering user may be outside the allowed user
list.

### Auto-review did not run

Auto-review only runs for newly opened, non-draft PRs. It is skipped for draft PRs, bot-authored
PRs, disabled repositories, and users who are not allowed to trigger the bot.

If a PR was converted from draft to ready for review, run `/open-inspect review this PR` in a PR
comment instead.

### A command did not start a session

Put `/open-inspect <instruction>` at the start of a non-quoted line on an issue, PR conversation, or
PR review thread. The full bot username, including `[bot]`, remains supported. Check the visible
skip response for a disabled repository or unauthorized user.

### I see an eyes reaction but no follow-up

The eyes reaction means the bot accepted the request. GitHub completion output is posted by the
agent, not by a managed bot callback. The session may still be running, or the agent may have failed
after the request was accepted. Open the Open-Inspect web app to inspect the session.

### The wrong model or instructions were used

Check **Settings > Integrations > GitHub**. Repository overrides take priority over global defaults.
Changes apply to new GitHub-triggered sessions.

### The bot is active in too many repositories

Limit the GitHub App installation to the repositories Open-Inspect should access. You can also set
**Repository Scope** to **Selected repositories** in the GitHub integration settings.
