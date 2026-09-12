---
id: 27-tldraw-board-deploy
title: tldraw board deploy workflow available via workflow_dispatch
type: rebuild
priority: low
placement: ci-config
depends_on: []
origin: fork; added on main after the sync-preview branch was cut
---

## Requirement

A manual (`workflow_dispatch`) GitHub Actions workflow exists that deploys the tldraw board
application to Cloudflare using the repository's Cloudflare credentials. Dispatching it produces a
live board; it never runs automatically on push or PR.

## Acceptance test (the contract)

The workflow appears in the Actions "Deploy tldraw board" picker on `main`, and a manual dispatch
completes with the board reachable at its Cloudflare URL. Verification is live-only by nature (it
needs the Cloudflare secrets and a real deploy).

## Placement decision (durable)

The workflow lives in the repository's CI config, restored verbatim each sync. The application
payload is embedded in the workflow itself (base64-compressed tarball), so the restore is a verbatim
file restore, not a rebuild.

## Provenance

Added fork-side on `main` shortly before the 2026-09-11 sync preview was cut, so the preview branch
does not contain it and merging the sync would silently delete it. This card exists so the next sync
restores it instead. Source blob: the pre-sync fork `main` history
(`.github/workflows/deploy-tldraw-board.yml` at `origin/main` commit `c28ecc0`).
