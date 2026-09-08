# infra/cloudflare

Terraform root for the Cloudflare-side edge of `frontdesk.jtrent.dev`
(#17; ADR-0002): DNS record, TLS mode, WAF managed rules, a rate-limit
rule, and a Turnstile widget. **Everything here is scoped to the single
host `frontdesk.jtrent.dev`.** The `jtrent.dev` zone already carries an
unrelated `A jtrent.dev` record and other hosts; nothing in this root may
touch a zone-wide setting (no `cloudflare_zone_setting` resources at all —
see `main.tf`'s header comment).

## Free-plan constraint (read before changing the rate-limit rule)

The zone is on Cloudflare's **Free** plan. That caps what's expressible
here in two ways this root works around rather than fights:

- **Rate limiting: exactly 1 rule, fixed 10s counting/mitigation period.**
  REQUIREMENTS F1's "10 requests/min per IP" cannot be written as a
  Cloudflare rate-limit rule on Free. The rule this root creates
  (`cloudflare_ruleset.rate_limit`, 20 req / 10s per `ip.src` +
  `cf.colo.id` on `/r/*` and `/api/*`) is a **coarser burst guard**, not
  F1 itself. **F1's actual per-minute limit is delivered at ingress in
  #18**, via `nginx.ingress.kubernetes.io/limit-rpm: "10"` on the
  form/API Ingress — ingress-nginx already keys on `CF-Connecting-IP`
  (#16). If F1's acceptance bar ("11th request/min → 429") is being
  checked, check it against #18's Ingress, not this rule; this rule's
  bar is "21st request within 10s → 429 from Cloudflare."
- **WAF: only the Cloudflare Free Managed Ruleset is available.** No
  OWASP Core Ruleset, no Exposed Credentials Check — those need Pro+.

## Token scopes

`cloudflare_api_token` needs a **Custom Token**, distinct from two others
already in use: the DNS-only token cert-manager reads in #16, and
whatever token lives in the Hermes VPS environment. Keeping this one
separate means any of the three can be revoked without touching the
others.

Create it: Cloudflare dashboard → My Profile → API Tokens → Create Token
→ Create Custom Token, named e.g. `frontdesk-terraform`.

| Scope | Permission | Why |
|---|---|---|
| Zone · DNS | Edit | the `frontdesk` record |
| Zone · Zone WAF | Edit | the managed-ruleset rule |
| Zone · Config Rules | Edit | the TLS-strict Configuration Rule |
| Zone · Zone | Read | zone lookups |
| Account · Turnstile | Edit | the widget |
| Account · Account Settings | Read | account-scoped resource lookups |

Zone Resources: Include → Specific zone → `jtrent.dev`. Account
Resources: this account. Put the token in `terraform.tfvars` as
`cloudflare_api_token = "..."`, `chmod 600`.

If `terraform plan`/`apply` returns 403 on a specific resource, the error
names the missing permission — add exactly that to this token; don't
widen a different one.

## State

Local state (`terraform.tfstate`, git-ignored), same decision as
`infra/hetzner` (ADR-0012): one operator, no CI apply job, nothing
sensitive in the file (the token isn't state; record IDs and rule
expressions aren't secrets). A remote backend gets its own ADR if a CI
apply job or a second operator arrives.

**After every `apply`, copy the state off-host**, same command shape as
`infra/hetzner/README.md`:

```
mkdir -p ~/backups/frontdesk-tfstate
scp trentcyber:code/frontdesk-intake/infra/cloudflare/terraform.tfstate \
  ~/backups/frontdesk-tfstate/terraform.tfstate.cloudflare.$(date +%FT%H%M%S)
```

**Recovery if the state is lost.** Every resource here has a stable
Cloudflare ID and can be re-adopted. IDs below are placeholders — fill
them in from `terraform show` (or the dashboard/API) right after the
first real `apply`, the same way `infra/hetzner/README.md` records its
Hetzner IDs:

```
cd infra/cloudflare
terraform init
terraform import cloudflare_dns_record.frontdesk       <zone_id>/<record_id>
terraform import cloudflare_ruleset.tls_strict          <zone_id>/<ruleset_id>
terraform import cloudflare_ruleset.waf_managed          <zone_id>/<ruleset_id>
terraform import cloudflare_ruleset.rate_limit           <zone_id>/<ruleset_id>
terraform import cloudflare_turnstile_widget.frontdesk   <sitekey>
terraform plan   # expect: No changes
```

### WAF managed-ruleset entrypoint: check before the first apply

A zone phase has **exactly one entrypoint ruleset**. Before the first
`apply`, check whether `jtrent.dev` already has one for
`http_request_firewall_managed` (the unrelated existing `A jtrent.dev`
record makes this plausible):

```
curl -s -H "Authorization: Bearer <frontdesk-terraform token>" \
  "https://api.cloudflare.com/client/v4/zones/45734fe2f45bf9f4728d7cafb9949d3a/rulesets?phase=http_request_firewall_managed"
```

- **`result` is empty:** nothing to do, `apply` creates
  `cloudflare_ruleset.waf_managed` fresh.
- **`result` is non-empty:** `apply` would try to create a second
  entrypoint and fail (or silently conflict). Instead, adopt the
  existing one first:
  ```
  terraform import cloudflare_ruleset.waf_managed <zone_id>/<existing_ruleset_id>
  terraform plan
  ```
  The plan should then show this root's rule (scoped to
  `frontdesk.jtrent.dev`) being added to the existing entrypoint, not a
  new ruleset being created. Review the diff before applying — an
  existing entrypoint may carry rules for other hosts on the zone that
  must not be touched.

## Usage

```
cd infra/cloudflare
cp terraform.tfvars.example terraform.tfvars   # fill in the token + real zone_id/account_id
terraform init
terraform plan -out=edge.tfplan                # expect 4 or 5 to add, 0 change, 0 destroy
terraform apply edge.tfplan
```

The `+4` vs `+5` depends on the WAF entrypoint check above: 5 new
resources if `waf_managed` is created fresh, 4 if it was imported instead
(that one shows as a change, not an add).

## Acceptance (paste real output into the PR)

```
dig +short frontdesk.jtrent.dev                       # 2 Cloudflare anycast IPs, never 167.233.178.242
curl -sI https://frontdesk.jtrent.dev/ | head -1       # HTTP/2 526 (origin cert self-signed until #18); header `server: cloudflare`
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 https://167.233.178.242/   # from off-VPS: 000, origin not directly reachable
for i in $(seq 1 25); do curl -s -o /dev/null -w '%{http_code} ' https://frontdesk.jtrent.dev/r/probe; done; echo   # 526s then 429 by the 21st
terraform output turnstile_site_key                    # 0x4AAA... (public)
terraform plan                                          # No changes
```

Turnstile challenge rendering is verified in #18, once there's a page to
put it on.

## Out of scope here

Ingress/Certificate for `frontdesk.jtrent.dev`, `limit-rpm` (the actual
F1 limit), sealing the Turnstile secret, namespace `frontdesk` — all #18.
Email routing and Workers are never in v1 (ADR-0002).

## Agent verification

Claude Code verifies with `terraform init -backend=false`, `terraform
fmt -check`, and `terraform validate` only. No `plan` (needs the token,
which the agent doesn't have — AI-GOVERNANCE: agents don't hold
production secrets), no `apply`, no reading `terraform.tfvars`, no
Cloudflare API calls.
