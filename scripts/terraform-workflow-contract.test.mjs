import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/terraform.yml", import.meta.url),
  "utf8"
);
const productionVariables = await readFile(
  new URL("../terraform/environments/production/variables.tf", import.meta.url),
  "utf8"
);

test("Daytona base snapshot memory reaches Terraform plan and apply", () => {
  const assignment =
    "TF_VAR_daytona_base_snapshot_memory_gib: \"${{ vars.DAYTONA_BASE_SNAPSHOT_MEMORY_GIB || '2' }}\"";
  const planStart = workflow.indexOf("\n  plan:\n");
  const applyStart = workflow.indexOf("\n  apply:\n");

  assert.notEqual(planStart, -1, "expected the Terraform plan job");
  assert.notEqual(applyStart, -1, "expected the Terraform apply job");

  const jobs = {
    plan: workflow.slice(planStart, applyStart),
    apply: workflow.slice(applyStart),
  };

  for (const [name, job] of Object.entries(jobs)) {
    const occurrences = job.split(assignment).length - 1;
    assert.equal(occurrences, 1, `expected one Daytona memory input in the ${name} job`);
  }
});

test("sandbox inactivity defaults to five minutes in Terraform and its workflow", () => {
  const variable = productionVariables.match(
    /variable "sandbox_inactivity_timeout_ms" \{([\s\S]*?)\n\}/
  );
  assert.ok(variable, "expected the sandbox inactivity variable");
  assert.match(variable[1], /default\s+=\s+300000/);

  const assignment =
    "TF_VAR_sandbox_inactivity_timeout_ms: \"${{ vars.SANDBOX_INACTIVITY_TIMEOUT_MS || secrets.SANDBOX_INACTIVITY_TIMEOUT_MS || '300000' }}\"";
  assert.equal(workflow.split(assignment).length - 1, 2);
});
