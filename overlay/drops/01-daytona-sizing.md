---
id: 01-daytona-sizing
title: Do not rebuild Daytona snapshot sizing
type: drop
origin: fork #329; retired when the deployment moved to Modal
---

## Decision

Do not rebuild Daytona sandbox resource sizing (the 2 vCPU / 8 GiB / 10 GiB snapshot contract) for
this deployment. The deployment runs Modal; Daytona is no longer a provider this deployment uses.

## Reason

The card existed to guarantee a Daytona snapshot was large enough to start the agent runtime. With
Modal as the sandbox provider, no Daytona snapshot is built or consumed, so the outcome has no
observable effect. Restoring it requires a new product decision to run Daytona again.
