---
id: 18-fork-ops-notes
title: Fork ops notes in the root agent doc
type: rebuild
priority: medium
placement: upstream-doc
depends_on: []
origin: fork operations; issues #75, #94
---

## Outcome

After an upstream sync, the root agent instructions still tell an operator how this fork deploys and
how to verify that a release reached production.

## Observable behavior

The instructions state that merging to `main` runs the Terraform deployment without a production
approval gate and that this deployment uses Daytona. They tell the operator to confirm that the
merge produced a workflow run and how to start `terraform.yml` when it did not.

They also explain that a healthy post-deploy plan is not empty because worker resources are replaced
on every plan, and that unexpected resources marked for creation indicate deployment drift.

The instructions also explain that sandbox image inputs propagate through the declared content hash,
and that a changed file outside those inputs does not rebuild the image. They reserve migration IDs
from 9000 onward for fork-local D1 migrations.

## Durable constraints

The facts must remain in the root instructions that agents read, even when a sync replaces upstream
documentation. The image content hash, not a manual version bump, controls propagation. The
migration-floor rule remains authoritative in `overlay/rules.md`; the root instructions state the
operator fact without creating a second rule.
