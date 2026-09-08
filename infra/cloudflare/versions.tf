terraform {
  required_version = ">= 1.6" # matches infra/hetzner (ADR-0012); nothing here needs newer

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
