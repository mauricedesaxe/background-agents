output "namespace_id" {
  description = "The ID of the KV namespace"
  value       = cloudflare_workers_kv_namespace.this.id
}

output "namespace_name" {
  description = "The name of the KV namespace"
  value       = cloudflare_workers_kv_namespace.this.title
}
