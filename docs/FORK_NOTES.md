# Fork notes

Divergences this fork carries on purpose, and why. Read this before merging upstream: anything
listed here is expected to conflict, and the resolution is to keep the fork's version unless the
note says otherwise.

## Automation templates: `content-ideas`

`packages/web/src/lib/automation-templates.ts` carries a `content-ideas` template that upstream does
not have and should not receive. It surveys a week of merged pull requests and closed issues and
proposes content ideas from the decisions behind them, posted to Slack.

It is fork-local because the prompt hardcodes personal context: `alexlazar.dev` as the source of
audience and ICP, a fixed list of exemplar videos that define the format, and two weighting rules
(agentic-harness work and go-to-market engineering) that only make sense for one person's service
offering. A generic version would need that context to come from configuration, which is more
machinery than one template is worth.

Maintenance the template needs, since none of it is enforced by a test:

- The exemplar video list goes stale as new videos are published. It is a style reference, so
  staleness is tolerable, but a format that drifts away from the list will not be proposed.
- The `#content` Slack channel is named in the instructions. Renaming the channel breaks delivery
  silently, since the template only asserts that _some_ `#channel` is mentioned.
- The prompt depends on the sandbox being able to reach `alexlazar.dev` and YouTube. Without network
  access it degrades to generic output rather than failing loudly.

The template is registered under `data-research`. It is not a clean fit, but adding a category for a
single template was judged not worth the taxonomy change.
