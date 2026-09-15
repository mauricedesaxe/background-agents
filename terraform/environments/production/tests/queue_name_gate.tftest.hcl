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

  modal_token_id     = "test-modal-token-id"
  modal_token_secret = "test-modal-token-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-modal-api-secret"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"
}

# A tftest cannot override the queue-name literals in workers-control-plane.tf,
# so the gate is exercised through var.deployment_name, the only input to
# local.name_suffix. The longest current literal ("open-inspect-image-build-"
# "finalization-", 38 chars) plus this 30-char suffix reaches 68 characters,
# past Cloudflare's 63-character cap, so the gate's precondition must fail the
# plan. Removing or weakening the gate makes this run fail the suite.
run "rejects_a_deployment_name_that_overflows_the_queue_budget" {
  command = plan

  variables {
    deployment_name = "queue-overflow-deployment-name"
  }

  expect_failures = [terraform_data.cloudflare_queue_name_gate]
}

# The 24-char suffix is the documented worst case (38 + 24 = 62): the longest
# current queue literal must stay inside the 63-character cap with it. A queue
# literal that grows by two or more characters fails this plan, so literal
# drift reddens even though the gate run above keeps passing.
run "keeps_the_documented_24_char_suffix_within_the_budget" {
  command = plan

  variables {
    deployment_name = "24-char-suffix-budget-ok"
  }

  assert {
    condition     = length("open-inspect-image-build-finalization-${var.deployment_name}") <= 63
    error_message = "The documented 24-char deployment_name budget must keep the longest queue literal within Cloudflare's 63-character cap."
  }
}
