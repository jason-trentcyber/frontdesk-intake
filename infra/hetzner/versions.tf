terraform {
  required_version = ">= 1.6"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
  }
}

# HCLOUD_TOKEN is read from the environment (the hcloud provider supports it
# natively) so the token never has to live in a .tfvars file. It is already
# in the VPS env per #2.
provider "hcloud" {}
