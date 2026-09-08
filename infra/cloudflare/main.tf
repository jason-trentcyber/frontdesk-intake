# ADR-0002: Cloudflare proxies frontdesk.jtrent.dev — DNS, TLS to visitor,
# WAF managed rules, a rate-limit rule on /r/* and /api/*, Turnstile on the
# public form, no Workers. Everything here is scoped to the single host
# `frontdesk.jtrent.dev`: the jtrent.dev zone already carries an unrelated
# `A jtrent.dev` record and other hosts, and this root must never touch a
# zone-wide setting.
#
# Free plan (checked 2026-09-08): rate limiting allows exactly 1 rule (10s
# counting/mitigation period, fixed — "10/min per IP" cannot be expressed
# here); only the Cloudflare Free Managed Ruleset is available for WAF. The
# REQUIREMENTS F1 10-requests-per-minute-per-IP limit is delivered at
# ingress in #18 (`nginx.ingress.kubernetes.io/limit-rpm`), not here — the
# rule below is a coarser burst guard in front of it.

locals {
  hostname    = "frontdesk.jtrent.dev"
  origin_ipv4 = "167.233.178.242" # infra/hetzner floating IP

  # https://developers.cloudflare.com/waf/managed-rules/ - "Cloudflare Free
  # Managed Ruleset", the only managed ruleset available on the Free plan.
  free_managed_ruleset_id = "77454fe2d30c4220b5701f6fdfb893ba"
}

resource "cloudflare_dns_record" "frontdesk" {
  zone_id = var.zone_id
  name    = "frontdesk"
  type    = "A"
  content = local.origin_ipv4
  ttl     = 1 # "Automatic"; required whenever proxied = true
  proxied = true
}

# TLS mode via a Configuration Rule, not the cloudflare_zone_setting SSL
# mode - that setting is zone-wide and jtrent.dev has other hosts on it.
# Until #18 ships a real cert, ingress-nginx answers 443 with its default
# self-signed cert, so this makes https://frontdesk.jtrent.dev/ return 526
# (expected #17 end state: proves the proxy path without a real origin
# cert yet). #18 turns it into 200.
resource "cloudflare_ruleset" "tls_strict" {
  zone_id     = var.zone_id
  name        = "frontdesk TLS mode"
  description = "SSL/TLS Strict for frontdesk.jtrent.dev only, via a Configuration Rule (never the zone-wide setting)."
  kind        = "zone"
  phase       = "http_config_settings"

  rules = [
    {
      description = "frontdesk.jtrent.dev -> SSL strict"
      expression  = "http.host eq \"${local.hostname}\""
      action      = "set_config"
      action_parameters = {
        ssl = "strict"
      }
    }
  ]
}

# A zone phase has exactly one entrypoint ruleset. If jtrent.dev already
# has one for http_request_firewall_managed, README.md's import recipe
# adopts it instead of this creating a second, conflicting entrypoint.
resource "cloudflare_ruleset" "waf_managed" {
  zone_id     = var.zone_id
  name        = "frontdesk WAF managed rules"
  description = "Executes the Cloudflare Free Managed Ruleset, scoped to frontdesk.jtrent.dev (the only managed ruleset the Free plan offers)."
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules = [
    {
      description = "Execute Cloudflare Free Managed Ruleset on frontdesk.jtrent.dev"
      expression  = "http.host eq \"${local.hostname}\""
      action      = "execute"
      action_parameters = {
        id = local.free_managed_ruleset_id
      }
    }
  ]
}

# Cloudflare-side burst guard, not the REQUIREMENTS F1 rate limit (that's
# nginx.ingress.kubernetes.io/limit-rpm at ingress, #18 - ingress-nginx
# already keys on CF-Connecting-IP from #16). Free plan allows exactly one
# rate-limiting rule, with a fixed 10s counting/mitigation period.
resource "cloudflare_ruleset" "rate_limit" {
  zone_id     = var.zone_id
  name        = "frontdesk burst guard"
  description = "20 requests / 10s per IP+colo on /r/* and /api/*, block for 10s. Free-plan burst guard in front of the ingress-level F1 limit."
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [
    {
      description = "Burst guard on /r/* and /api/*"
      expression  = "http.host eq \"${local.hostname}\" and (starts_with(http.request.uri.path, \"/r/\") or starts_with(http.request.uri.path, \"/api/\"))"
      action      = "block"
      ratelimit = {
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = 10
        requests_per_period = 20
        mitigation_timeout  = 10
      }
    }
  ]
}

# Account-scoped. Site key is public (outputs.tf -> .env.example). The
# secret key is not sealed here - the frontdesk app namespace doesn't
# exist until #18, which is where it gets sealed.
resource "cloudflare_turnstile_widget" "frontdesk" {
  account_id = var.account_id
  name       = "frontdesk"
  domains    = [local.hostname, "localhost"]
  mode       = "managed"
}
