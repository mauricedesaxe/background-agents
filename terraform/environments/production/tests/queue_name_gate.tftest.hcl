mock_provider "cloudflare" {}
mock_provider "external" {
  mock_data "external" {
    defaults = {
      result = {
        hash = "test-source-hash"
      }
    }
  }
}
mock_provider "local" {}
mock_provider "null" {}
mock_provider "random" {}
mock_provider "vercel" {}

variables {
  cloudflare_api_token        = "test-cloudflare-token"
  cloudflare_account_id       = "test-account"
  cloudflare_worker_subdomain = "test-account"
  github_app_id               = "1"
  github_app_private_key      = "test-private-key"
  github_app_installation_id  = "1"
  github_webhook_secret       = "test-github-webhook-secret"
  github_bot_username         = "test-bot"
  slack_bot_token             = "test-slack-token"
  slack_signing_secret        = "test-slack-signing-secret"
  anthropic_api_key           = "test-anthropic-key"
  token_encryption_key        = "test-token-key"
  repo_secrets_encryption_key = "test-repo-key"
  nextauth_secret             = "test-browser-auth-secret-with-32-characters"
  modal_token_id              = "test-modal-token-id"
  modal_token_secret          = "test-modal-token-secret"
  modal_workspace             = "test-workspace"
  modal_api_secret            = "test-modal-api-secret"
  web_platform                = "cloudflare"
  project_root                = "../../../"
  enable_linear_bot           = false
  github_client_id            = "github-id"
  github_client_secret        = "github-secret"
  allowed_users               = "octocat"
}

run "accepts_a_63_character_queue_name_with_optional_queues_disabled" {
  command = plan

  variables {
    deployment_name   = "1234567890123456789012345"
    enable_github_bot = false
    enable_slack_bot  = false
  }

  assert {
    condition     = max([for name in local.active_cloudflare_queue_names : length(name)]...) == 63
    error_message = "The boundary fixture must produce one 63-character queue name."
  }

  assert {
    condition     = length(local.active_cloudflare_queue_names) == 2
    error_message = "Disabled bot queues must not participate in the queue-name gate."
  }

  assert {
    condition = (
      cloudflare_queue.image_build_finalization.queue_name == local.cloudflare_queue_names.image_build_finalization &&
      cloudflare_queue.image_build_finalization_dlq.queue_name == "open-inspect-image-build-dlq-${var.deployment_name}"
    )
    error_message = "The required queue resources must use the centralized names and shortened DLQ prefix."
  }
}

run "accepts_all_enabled_queues_within_the_limit" {
  command = plan

  variables {
    deployment_name   = "1234567890123456789012345"
    enable_github_bot = true
    enable_slack_bot  = true
  }

  assert {
    condition     = alltrue([for name in local.active_cloudflare_queue_names : length(name) <= 63])
    error_message = "Every enabled Cloudflare queue name must fit the 63-character limit."
  }

  assert {
    condition     = length(local.active_cloudflare_queue_names) == 6
    error_message = "The gate must cover every enabled Cloudflare queue."
  }

  assert {
    condition = (
      cloudflare_queue.github_autofix[0].queue_name == local.cloudflare_queue_names.github_autofix &&
      cloudflare_queue.github_autofix_dlq[0].queue_name == local.cloudflare_queue_names.github_autofix_dlq &&
      cloudflare_queue.slack_completion_delivery[0].queue_name == local.cloudflare_queue_names.slack_completion_delivery &&
      cloudflare_queue.slack_completion_delivery_dlq[0].queue_name == local.cloudflare_queue_names.slack_completion_delivery_dlq
    )
    error_message = "Every optional queue resource must use its centralized queue name."
  }
}

run "rejects_a_64_character_queue_name_before_apply" {
  command = plan

  variables {
    deployment_name   = "12345678901234567890123456"
    enable_github_bot = false
    enable_slack_bot  = false
  }

  expect_failures = [terraform_data.cloudflare_queue_name_gate]
}
