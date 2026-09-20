---
id: 17-jj-sandbox-install
title: Sandbox CLI toolchain supports jj and bd workflows
type: rebuild
priority: high
placement: sandbox-image
depends_on: []
origin: fork
---

## Outcome

A fresh sandbox has the repository tools needed to commit and ship work with `jj` and to continue an
existing durable task graph with `bd`.

## Observable behavior

In a fresh sandbox, `jj --version` and `bd --version` report the pinned versions. `jj` completes the
commit and ship workflow, including a colocated push with the repository's credentials.

For a repository whose origin already contains a `bd` graph, one fresh sandbox can adopt the graph,
change it, and push it. A second fresh sandbox can adopt the graph and read the change. For a
repository without a graph, `bd` does not initialize one unless the user asks.

Installed agent guidance explains how to adopt an existing graph, forbids unrequested
initialization, and requires a single writer for graph changes.

## Durable constraints

Both CLIs are available on `PATH` with `jj` pinned to **0.44.0** and `bd` pinned to **1.2.2**, and
are installed from integrity-verified artifacts. Every installation lane uses the same pins. The
`bd` graph remains in repository refs, round-trips through normal repository credentials, and has
only one writer at a time. Toolchain changes reach fresh sandboxes through the sandbox image's
content-hash rebuild path.
