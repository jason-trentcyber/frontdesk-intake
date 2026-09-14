# ADR-0032: `AUTH_URL` (derived from `ingress.host`) replaces `AUTH_TRUST_HOST=true`; amends ADR-0031

Status: decided 2026-09-14. Amends ADR-0031's Consequences clause "gains ... `AUTH_TRUST_HOST=true`". Everything else in ADR-0031 stands.

## Context

ADR-0031 decided web's Deployment env gains `AUTH_TRUST_HOST=true`, reasoning that self-hosted-behind-a-proxy deployments need it so Auth.js trusts the forwarded host header. That shipped in #119. Verified against production just now: it didn't fix the actual problem. `GET /api/auth/providers` in-pod reported `"signinUrl": "http://0.0.0.0:3000/api/auth/signin/google"` — `AUTH_TRUST_HOST` governs whether a forwarded-host header is *trusted*, not what origin Auth.js derives when nothing in its own request path has told it what the public origin actually is; the pod's own bind address filled that gap instead.

Checked against `@auth/core`'s own source (`@auth/core/lib/utils/env.js`'s `setEnvDefaults`), not assumed:

```js
config.trustHost ?? (config.trustHost = !!(envObject.AUTH_URL ??
    envObject.AUTH_TRUST_HOST ??
    envObject.VERCEL ??
    envObject.CF_PAGES ??
    envObject.NODE_ENV !== "production"));
```

`AUTH_URL` is checked before `AUTH_TRUST_HOST` in that fallback chain — setting `AUTH_URL` already sets `config.trustHost = true` as a side effect, with nothing left for a separate `AUTH_TRUST_HOST=true` to do. Separately, `next-auth`'s own `reqWithEnvURL()` (`next-auth/lib/env.js`) rewrites every incoming request's URL to swap in `AUTH_URL`'s origin before any other Auth.js code runs — this is the actual mechanism that fixes the `0.0.0.0` origin; `trustHost` alone (however it gets set) never did.

## Decision

Web's Deployment env sets `AUTH_URL: "https://{{ .Values.ingress.host }}"` — the same knob `PUBLIC_WEB_ORIGIN`/`API_ORIGIN` already derive from, never hardcoded (ADR-0002: no Cloudflare/Hetzner/k3s names in `deploy/chart/`). `AUTH_TRUST_HOST` is removed, not kept alongside it: it would be fully redundant per the source above, and leaving a redundant var in the manifest invites a future reader to wonder which one is actually in effect.

## Consequences

- `deploy/chart/templates/deployment.yaml`'s web container env: `AUTH_TRUST_HOST=true` → `AUTH_URL: "https://{{ .Values.ingress.host }}"`.
- `deploy/chart/check-manifest-refs.sh` gains a check that `AUTH_URL`'s rendered value equals `https://` plus the Ingress's own rendered host — a real cross-resource assertion, not just "present" (26a follow-up, #26).
- Revisit trigger: if a future Auth.js major version changes `setEnvDefaults`'s fallback order (unlikely to remove `AUTH_URL`'s priority, since it is the more specific signal), re-check this reasoning against the version actually pinned in `web/package.json` before assuming it still holds.

## Rejected

- **Keep both `AUTH_URL` and `AUTH_TRUST_HOST=true`.** Costs nothing to run, but leaves two variables where the source shows only one is doing anything — worse than either alone for a future reader trying to understand what governs the trust decision.
- **Keep `AUTH_TRUST_HOST=true` and drop `AUTH_URL`.** Doesn't fix the actual bug: `trustHost` alone doesn't change what origin `reqWithEnvURL()`/`createActionURL()` construct URLs against when nothing else supplies one; the `0.0.0.0` origin in production is `AUTH_URL`'s absence, not `trustHost`'s.
