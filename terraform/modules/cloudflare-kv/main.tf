# Cloudflare KV Namespace Module
# Creates and manages Cloudflare Workers KV namespaces

resource "cloudflare_workers_kv_namespace" "this" {
  account_id = var.account_id
  title      = var.namespace_name
}
