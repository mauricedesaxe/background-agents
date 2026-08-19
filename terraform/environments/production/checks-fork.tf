# =============================================================================
# Fork-only guards (overlay-owned, preserved across upstream sync)
# =============================================================================
# Kept out of the upstream-owned checks.tf so a blind sync cannot clobber it.
# See docs/FORK.md and overlay/cards/03-queue-name-length.md.

locals {
  # Every derived Cloudflare queue name in this deployment. The slack queues are
  # conditional on enable_slack_bot, so the splat yields an empty list when off.
  derived_queue_names = concat(
    [
      cloudflare_queue.image_build_finalization.queue_name,
      cloudflare_queue.image_build_finalization_dlq.queue_name,
    ],
    cloudflare_queue.slack_completion_delivery[*].queue_name,
    cloudflare_queue.slack_completion_delivery_dlq[*].queue_name,
  )
}

# Fail the plan when any derived queue name would exceed Cloudflare's 63-char
# cap. deployment_name suffixes every queue literal, so a long deployment_name
# or a lengthened upstream literal overflows the cap and makes `apply` hit a 400
# mid-run — a partial apply. This catches it at plan, before any resource is
# touched.
resource "terraform_data" "queue_name_length_gate" {
  lifecycle {
    precondition {
      condition = alltrue([
        for name in local.derived_queue_names : length(name) <= 63
      ])
      error_message = "Derived Cloudflare queue name(s) exceed the 63-char limit: ${join(", ", [for name in local.derived_queue_names : "${name} (${length(name)} chars)" if length(name) > 63])}. Shorten the queue literal or the deployment_name."
    }
  }
}
