---
id: 29-glm-model-catalog
title: GLM 5.3 models stay selectable with reasoning effort
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: fork commits dce5239, 3920a75, 70f3f9c
---

## Outcome

Users can select GLM 5.3 and GLM 5.3 Flash from the model picker under both the OpenCode Zen and
Z.AI Coding Plan providers, and the reasoning-effort control reaches the model on Z.AI Coding Plan.

## Observable behavior

The picker lists `glm-5.3-flash` and `glm-5.3` under OpenCode Zen and under Z.AI Coding Plan.
Selecting either model on either provider runs the session with that model. On Z.AI Coding Plan,
choosing a reasoning effort of low, high, or max forwards that effort into the model request; the
session runs with the chosen effort. With no effort selected, no effort is sent and the provider
default applies.

## Durable constraints

These catalog entries are fork additions upstream does not ship; a sync must not drop them merely
because upstream lacks them. Reasoning effort is forwarded only for providers that declare effort
variants; other providers must not receive an effort field. The model IDs remain exactly `glm-5.3`
and `glm-5.3-flash`. Z.AI Coding Plan is this deployment's production model provider, so losing
these entries breaks the deployment, not just a preference.
