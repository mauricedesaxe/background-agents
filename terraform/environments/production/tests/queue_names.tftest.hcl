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
  anthropic_api_key           = "test-anthropic-key"
  token_encryption_key        = "test-token-key"
  repo_secrets_encryption_key = "test-repo-key"
  nextauth_secret             = "test-browser-auth-secret-with-32-characters"
  deployment_name             = "openinspect-leetsoftware"

  sandbox_provider   = "modal"
  modal_token_id     = "test-token"
  modal_token_secret = "test-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-api-secret"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"
}

run "image_build_dead_letter_queue_keeps_its_deployed_name" {
  command = plan

  assert {
    condition     = cloudflare_queue.image_build_finalization_dlq.queue_name == "open-inspect-image-build-dlq-openinspect-leetsoftware"
    error_message = "The image build dead-letter queue must retain its deployed name."
  }

  assert {
    condition     = length(cloudflare_queue.image_build_finalization_dlq.queue_name) < 63
    error_message = "The image build dead-letter queue must fit Cloudflare's queue name limit."
  }

  assert {
    condition     = cloudflare_queue_consumer.image_build_finalization.dead_letter_queue == cloudflare_queue.image_build_finalization_dlq.queue_name
    error_message = "The image build consumer must use the deployed dead-letter queue."
  }
}
