# Sync runbook

Run this sequence for every upstream sync. A failed gate blocks the sync or rolls back the deploy.

## Prepare the sync

1. Record the current fork `main` SHA as the rollback target.
2. Fetch upstream.
3. Create the sync branch from upstream `main`.
4. Restore `overlay/` from the fork.
5. Run `python overlay/check_cards.py`.
6. Confirm the production D1 ledger before changing migrations.

The starting tree must equal upstream plus `overlay/`. Do not merge upstream into the existing fork
tree, because stale fork files can survive that merge unnoticed.

## Rebuild active cards

Read every file under `cards/`. Apply cards in `depends_on` order. For each card:

1. Read the outcome and observable behavior.
2. Find the relevant behavior on the current upstream tree.
3. Rebuild the smallest change that satisfies the card.
4. Add or update a behavior-level check for that outcome.
5. Run the check before starting the next dependent card.

Do not use old file locations or current fork code as the design. They are evidence only.

## Run pre-deploy gates

1. Run the full repository CI suite, including type checks and every test suite discovered by the
   current upstream project.
2. Confirm that the sandbox-runtime JavaScript suites execute and block the change when one fails.
3. Confirm that fork migration IDs remain append-only and begin at 9000.
4. Confirm that planning rejects any Cloudflare queue name over 63 characters before apply.
5. Confirm that the five-minute idle default reaches the deployment configuration.
6. Confirm that the root agent instructions contain the operator facts from card 18.
7. Run each deterministic card check named by the card's observable behavior.

Do not land a sync with a skipped or failing gate.

## Deploy and verify

Wait for infrastructure and sandbox image work to finish before testing the deployed product.

1. Run card 06. A real session connects within 240 seconds and answers within 180 seconds.
2. Run card 16 after the web worker deploy. DNS, TLS, and HTTP all succeed on the public hostname.
3. Verify card 02 with a disconnected idle session, then with a connected client that receives a
   warning and a five-minute grace period.
4. Restart a persistent sandbox containing committed, staged, dirty, and untracked repository state.
   Repeat after an original boot from a repository image and before the first prompt. Confirm all
   four survive unchanged, first-boot setup does not repeat, and remote refresh failure only warns.
5. Run the live checks required by any other card changed during the sync.

If a deployed check fails, restore the recorded rollback SHA and redeploy. Do not infer success from
a green plan, a created sandbox, or a workflow that never ran.
