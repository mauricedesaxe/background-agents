---
{
  "version": 1,
  "kind": "hypotheses",
  "task": "deploy-repair",
  "created": "2026-10-18T10:33:44.994Z"
}
---

# Hypotheses

Give each explanation an ID. Link supporting and contradicting fact IDs. Record a discriminating test, result and status. A successful test adds an observation to facts.md.

- H1, confirmed by F1/F3/F4. Fork migration 9000 already performed four of five additions in upstream 0081; replaying 0081 cannot work. Repair only the missing reasoning_tokens column and record 0081 atomically. Unchanged remaining migrations passed on the live-schema scratch copy.
- H2, confirmed by F1/F5. Upstream expands the existing valid queue name past Cloudflare's limit. Retain the existing shorter DLQ name in Terraform and test consumer linkage.
