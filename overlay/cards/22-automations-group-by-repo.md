---
id: 22-automations-group-by-repo
title: The automations list groups by repository
type: rebuild
priority: medium
placement: upstream-code
depends_on: []
origin: fork; issue #328; automations-page readability
---

## Outcome

The automations page groups entries under headings that make their repository scope clear at a
glance.

## Observable behavior

An automation for one repository appears under that repository's `owner/name` heading. An automation
for more than one repository appears under a distinct "Multiple repositories" heading. An automation
with no repository target appears under a distinct "Environment only" heading.

Repository headings sort alphabetically. The two scope headings follow them and appear only when
they contain entries. Loading another page updates the existing groups, so each loaded automation
appears once and a repository does not gain a second heading.

## Durable constraints

Grouping must remain understandable across pagination and preserve the order of entries within each
group. Single-repository, multi-repository, and environment-only automations remain separate cases.
The behavior does not depend on another overlay card.
