variable "cloudflare_api_token" {
  description = "Cloudflare API token scoped to the jtrent.dev zone: Zone DNS Edit, Zone WAF Edit, Zone Config Rules Edit, Zone Zone Read, Account Turnstile Edit, Account Settings Read. A *third*, distinct token from the DNS-only one cert-manager uses in #16 (WAF/rulesets/Turnstile are outside 'Edit zone DNS') and from the Hermes env's token. Sensitive; set only in terraform.tfvars."
  type        = string
  sensitive   = true
}

variable "zone_id" {
  description = "Cloudflare zone ID for jtrent.dev. Not a secret (visible in the dashboard/API to anyone with zone access)."
  type        = string
}

variable "account_id" {
  description = "Cloudflare account ID. Not a secret. Needed for the account-scoped Turnstile widget."
  type        = string
}
