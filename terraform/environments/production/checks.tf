# Verify the Vercel production URL matches our hardcoded pattern. If Vercel
# assigns a different domain (e.g., due to naming conflicts), browser-auth
# redirects and cross-service references will silently break.
check "vercel_url_matches" {
  assert {
    condition = (
      var.web_platform != "vercel" ||
      length(module.web_app) == 0 ||
      module.web_app[0].production_url == local.web_app_url
    )
    error_message = "Vercel assigned URL '${var.web_platform == "vercel" && length(module.web_app) > 0 ? module.web_app[0].production_url : "n/a"}' but local.web_app_url is '${local.web_app_url}'. Update locals or set a custom domain."
  }
}

# Fail the plan when a custom domain is set but cannot take effect — wrong web
# platform or missing zone ID. Hostname shape is validated on the variable
# itself; this gate owns the cross-input policy, expressed via the normalized
# locals so enablement (web_custom_domain_enabled) and enforcement stay in sync.
resource "terraform_data" "cloudflare_custom_domain_gate" {
  lifecycle {
    precondition {
      condition     = local.web_custom_domain == "" || local.web_custom_domain_enabled
      error_message = "cloudflare_custom_domain is set but would be silently ignored: it requires web_platform = \"cloudflare\" and a non-empty cloudflare_zone_id."
    }
  }
}

# Fail the plan when no access control is configured. Uses terraform_data with a
# precondition so this is a hard error, not an advisory check-block warning.
resource "terraform_data" "access_control_gate" {
  lifecycle {
    precondition {
      condition     = local.admission_allowlist_enabled || var.unsafe_allow_all_users
      error_message = "At least one access control allowlist must be configured. Set allowed_users, allowed_email_domains, allowed_emails, or allowed_github_orgs, or set unsafe_allow_all_users = true to explicitly allow all authenticated users."
    }
  }
}

resource "terraform_data" "sign_in_provider_gate" {
  lifecycle {
    precondition {
      condition     = local.github_oauth_enabled || local.google_enabled
      error_message = "At least one complete OAuth sign-in provider pair must be configured."
    }

    precondition {
      condition = (
        !local.github_oauth_enabled ||
        local.github_admission_enabled ||
        local.provider_neutral_admission_enabled ||
        local.unsafe_allow_all_effective
      )
      error_message = "GitHub sign-in requires a GitHub-specific or provider-neutral admission rule, or effective unsafe allow-all."
    }

    precondition {
      condition = (
        !local.google_enabled ||
        local.provider_neutral_admission_enabled ||
        local.unsafe_allow_all_effective
      )
      error_message = "Google sign-in requires allowed_emails, allowed_email_domains, or effective unsafe allow-all; GitHub-specific admission rules cannot admit Google identities."
    }
  }
}

# Fail the plan when any queue name derived in workers-control-plane.tf would
# exceed Cloudflare's 63-character queue-name cap. An overflow only surfaces as
# an API 400 mid-apply (a partial apply), so the budget is enforced here, where
# nothing has been touched yet. The literals mirror workers-control-plane.tf,
# which documents the per-name budget; resource attributes are avoided because
# a computed queue_name is not known at plan time and would defer this check.
locals {
  queue_names = concat(
    [
      "open-inspect-image-build-finalization-${local.name_suffix}",
      "open-inspect-image-build-dlq-${local.name_suffix}",
    ],
    [
      "open-inspect-github-autofix-${local.name_suffix}",
      "open-inspect-github-autofix-dlq-${local.name_suffix}",
    ],
  )
}

resource "terraform_data" "cloudflare_queue_name_gate" {
  lifecycle {
    precondition {
      condition     = alltrue([for q in local.queue_names : length(q) <= 63])
      error_message = "Derived Cloudflare queue names exceed the 63-character limit: ${join(", ", [for q in local.queue_names : q if length(q) > 63])}. Shorten the queue name literals in workers-control-plane.tf."
    }
  }
}
