# ADR-0002: ingress-nginx + cert-manager in cluster, Cloudflare at the edge

Status: decided 2026-09-07

## Decision
- ingress-nginx as the ingress controller (identical manifests on EKS behind an NLB).
- cert-manager with Let's Encrypt DNS-01 via Cloudflare API token so certs work before the origin is public.
- Cloudflare proxies `frontdesk.jtrent.dev`: DNS, TLS to visitor, WAF managed rules, rate-limit rule on `/r/*` and `/api/*`, Turnstile on the public form. Origin is locked to Cloudflare IP ranges by the Hetzner firewall.
- No Cloudflare Workers in v1.

## Rejected
- Traefik (k3s default): fine, but less common on EKS; disabled for portability.
- Caddy: excellent on a single host, not a mainstream k8s ingress.
- Workers for app logic: separate runtime and deploy path, off-thesis.
