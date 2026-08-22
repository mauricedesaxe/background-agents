locals {
  derived_queue_names = concat(
    [
      cloudflare_queue.image_build_finalization.queue_name,
      cloudflare_queue.image_build_finalization_dlq.queue_name,
    ],
    cloudflare_queue.slack_completion_delivery[*].queue_name,
    cloudflare_queue.slack_completion_delivery_dlq[*].queue_name,
  )
}

resource "terraform_data" "queue_name_length_gate" {
  lifecycle {
    precondition {
      condition = alltrue([
        for name in local.derived_queue_names : length(name) <= 63
      ])
      error_message = "Derived Cloudflare queue names exceed the 63-character limit: ${join(", ", [for name in local.derived_queue_names : "${name} (${length(name)} characters)" if length(name) > 63])}. Shorten the queue literal or deployment_name."
    }
  }
}
