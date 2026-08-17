# Rollout and rollback for the first converged deployment

Decision for [#269](https://github.com/mauricedesaxe/background-agents/issues/269): how the first
reconstructed deployment rolls out, proves retained behavior in production, and rolls back safely.
The reconstruction follows [RECONSTRUCTION_PLAN.md](RECONSTRUCTION_PLAN.md) with jj-colocation added
per Alex's decision. Under the full-autonomy posture in [SYNC_METHOD.md](SYNC_METHOD.md), the
rollout has no human approval gates.

## Rollout sequencing

1. **jj-colocate the repo.** `jj git init --colocate` vends a `.jj` directory alongside `.git`. This
   is the bootstrap step, done once before the reconstruction. The fork currently has no `.jj`
   (`ls .jj` returns nothing); jj-colocation makes local history operations jj-native while keeping
   the git remote interop.

2. **Build the reconstruction branch** per RECONSTRUCTION_PLAN.md, adapted for jj:
   - `jj git fetch upstream`
   - `jj new main` — start at fork `main` tip.
   - Replace the working tree with current upstream head. Commit with `jj describe -m`.
   - **jj-colocation note.** jj's auto-snapshot model means every write is a new change. The replace
     commit is built as one `jj commit` whose tree matches `upstream/main`, verified by
     `jj diff --summary -r <replace> --from upstream/main` (empty = byte-identical).
   - Apply additive overlay commits (`jj new`, write files, `jj commit`).
   - Apply thin integration patches per seam.
   - `jj bookmark create reconstruct/upstream-<short> -r @`

3. **Run the acceptance gate** per OVERLAY_ACCEPTANCE_GATE.md. Every section runs unattended. A gate
   failure pages a human and the rollout does not proceed.

4. **Merge the reconstruction.** The cutover PR merges with a plain merge commit (not rebase-merge),
   consistent with the RECONSTRUCTION_PLAN.md's "the cutover must be a plain merge" and the
   SYNC_METHOD.md's merge-commit policy.

5. **Deploy.** `gh workflow run terraform.yml --ref main` triggers on merge. Terraform apply deploys
   the control plane and D1 migrations. Web deploys depend on `web_platform`.

6. **Daytona probe.** A new sandbox boots from the rebuilt snapshot and completes setup hooks. A
   resume of an existing session reattaches on the same sandbox. A prompt exercises the retained
   seams (reattach, compaction, event pump, jj PR helper).

7. **Production probe.** A real session creates a prompt, runs through the WebSocket chain, and
   confirms the transcript and streamed events arrive intact.

8. **Declare cutover.** The head-check cursor ref is set to the integrated upstream SHA
   (`refs/sync/last-integrated-upstream`). The recurring sync automation is now operational.

No observation window after deployment. The probes are the gate, and the gate is automatic. A probe
failure pages a human and the rollout does not reach "declared."

## Rollback

Rollback deploys the pre-cutover tag (RECONSTRUCTION_PLAN.md's `fork/pre-reconstruction-<short>`)
and reverts the D1 migration `release` step. The reconstruction's additive migrations stay in the
store; the old code does not query the new columns and they cause no harm. Provider state is
untouched (Daytona sandboxes are not recreated). The jj-colocation `.jj` directory is metadata, not
deployed code, and is preserved across rollback.

After a rollback, the cursor ref is deleted so the next cutover attempt starts clean. The failed
cutover's reconstruction branch, PR, and check results are preserved as diagnostic evidence.

## Interaction with the sync method

After the cutover, the recurring SYNC_METHOD.md coordinator runs the same steps (3-8) against each
new upstream range, except the jj-colocation bootstrap (step 1) which is done once. The acceptance
gate, deployment, and probes are the same automated sequence whether it is the first cutover or the
hundredth sync.
