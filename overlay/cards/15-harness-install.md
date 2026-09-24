---
id: 15-harness-install
title: Selectable Lazar managed skills
type: rebuild
priority: high
placement: managed-skills
depends_on: []
origin: fork
---

## Outcome

Users can choose a managed Lazar skills profile for a session instead of receiving Lazar skills in
every sandbox.

## Observable behavior

A session created with the Lazar profile can discover and invoke the selected `lazar-*` skills. A
session created with no managed skills has no Lazar skills. After the managed Lazar skills are
updated, newly created sessions receive the updated versions without rebuilding the sandbox image.
The update is previewed before import, and each imported skill records its source revision and
content digest.

## Durable constraints

Skill selection is explicit per session, and unselected skills must not leak into that session.
Updates apply to new sessions independently of the sandbox image lifecycle while existing sessions
remain stable. This profile imports skills only; rules, hooks, agents, binaries, and command
adapters require separate product decisions.
