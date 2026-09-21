---
id: 01-daytona-sizing
title: Daytona sandbox resource sizing
type: rebuild
priority: high
placement: snapshot
depends_on: []
origin: fork #329
---

## Outcome

Every Daytona session sandbox has enough CPU, memory, and disk to start and run the agent runtime.

## Observable behavior

A newly built Daytona snapshot provides at least **2 vCPU, 8 GiB of memory, and 10 GiB of disk**. A
sandbox created from that snapshot starts the runtime without resource exhaustion.

## Durable constraints

- The snapshot, not per-session settings, owns Daytona resource sizing.
- The deployment's current Daytona organization limit is **8 GiB of memory**. Raise that limit
  before increasing sandbox memory.
- The deployment's current Daytona per-sandbox disk limit is **10 GiB**. Raise that limit before
  increasing sandbox disk.
- Snapshot changes propagate through the content hash of the declared build inputs. A runtime
  version label does not trigger a rebuild.
