output "turnstile_site_key" {
  description = "Public Turnstile site key. Goes in .env.example / .env as TURNSTILE_SITE_KEY."
  value       = cloudflare_turnstile_widget.frontdesk.sitekey
}

output "turnstile_secret_key" {
  description = "Turnstile secret key. Not sealed by this root - #18 creates the frontdesk namespace and seals it there."
  value       = cloudflare_turnstile_widget.frontdesk.secret
  sensitive   = true
}
