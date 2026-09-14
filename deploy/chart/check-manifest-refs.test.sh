#!/usr/bin/env bash
# Tests for check-manifest-refs.sh.
#
# A guard whose failure mode is passing when it should fail is worse than no
# guard, and this one parses YAML by shape (see the assumptions in the script
# header). These fixtures pin that behaviour: if a future edit breaks the
# parser, the dangling-ref fixture stops failing and this test catches it.
#
# Run: bash deploy/chart/check-manifest-refs.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/check-manifest-refs.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0

expect() {
  local name="$1" want="$2" file="$3"
  local got=0
  bash "$script" "$file" >/dev/null 2>&1 || got=$?
  if [ "$got" -eq "$want" ]; then
    echo "ok   - $name (exit $got)"
  else
    echo "FAIL - $name: expected exit $want, got $got" >&2
    failures=$((failures + 1))
  fi
}

# Dangling: the Deployment names an SA that is never emitted. This is exactly
# the shape the chart had after #99 and must exit non-zero.
cat > "$tmp/dangling.yaml" <<'YAML'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: frontdesk-api
  labels:
    app.kubernetes.io/name: frontdesk
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontdesk-worker
spec:
  template:
    spec:
      serviceAccountName: frontdesk-worker
      containers:
        - name: worker
YAML
expect "dangling serviceAccountName fails" 1 "$tmp/dangling.yaml"

# Satisfied: every referenced SA is emitted.
cat > "$tmp/ok.yaml" <<'YAML'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: frontdesk-worker
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontdesk-worker
spec:
  template:
    spec:
      serviceAccountName: frontdesk-worker
YAML
expect "satisfied reference passes" 0 "$tmp/ok.yaml"

# "default" always exists in a namespace and is never templated.
cat > "$tmp/default.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontdesk-thing
spec:
  template:
    spec:
      serviceAccountName: default
YAML
expect "serviceAccountName: default passes" 0 "$tmp/default.yaml"

# A CronJob nests the pod template one level deeper; the reference must still
# be seen (the chart's postgres backup CronJob is this shape).
cat > "$tmp/cronjob.yaml" <<'YAML'
apiVersion: batch/v1
kind: CronJob
metadata:
  name: frontdesk-db-backup
spec:
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: frontdesk-backup
YAML
expect "nested CronJob reference is seen" 1 "$tmp/cronjob.yaml"

# No references at all is not an error.
cat > "$tmp/empty.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: frontdesk-config
YAML
expect "manifest with no references passes" 0 "$tmp/empty.yaml"

# --- Ingress routing + AUTH_URL fixtures (26a follow-up, #26) ---
#
# Shared shape across the fixtures below: a web Service, an api Service, an
# Ingress, and web's Deployment env - minimal versions of what `helm
# template` actually renders, only the piece under test varies.

# Correct: /api/auth and / -> web, /api -> api, AUTH_URL matches the host.
cat > "$tmp/ingress-ok.yaml" <<'YAML'
apiVersion: v1
kind: Service
metadata:
  name: frontdesk-web
  labels:
    app.kubernetes.io/component: web
---
apiVersion: v1
kind: Service
metadata:
  name: frontdesk-api
  labels:
    app.kubernetes.io/component: api
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: frontdesk-web
spec:
  rules:
    - host: frontdesk.example.com
      http:
        paths:
          - path: /api/auth
            pathType: Prefix
            backend:
              service:
                name: frontdesk-web
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: frontdesk-api
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontdesk-web
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontdesk-web
  labels:
    app.kubernetes.io/component: web
spec:
  template:
    spec:
      containers:
        - name: web
          env:
            - name: AUTH_URL
              value: "https://frontdesk.example.com"
YAML
expect "ingress: /api/auth -> web, /api -> api, / -> web, AUTH_URL matches passes" 0 "$tmp/ingress-ok.yaml"

# The exact regression this whole check exists for: no /api/auth rule at
# all, so Auth.js's endpoints would fall through to the plain /api prefix
# below (routed to api/, which has no such route).
sed '/path: \/api\/auth/,+4d' "$tmp/ingress-ok.yaml" > "$tmp/ingress-missing-auth-rule.yaml"
expect "ingress: missing /api/auth rule fails" 1 "$tmp/ingress-missing-auth-rule.yaml"

# Same bug, different shape: the rule exists but still points at api/,
# not web/ (e.g. someone "fixed" #99's copy-paste the wrong way). Only the
# /api/auth rule's own backend name changes - awk turns itself off after
# the first substitution so the later "/" rule's "name: frontdesk-web"
# line is left alone.
awk '
  /path: \/api\/auth$/ { in_auth = 1 }
  in_auth && /name: frontdesk-web$/ { sub(/name: frontdesk-web$/, "name: frontdesk-api"); in_auth = 0 }
  { print }
' "$tmp/ingress-ok.yaml" > "$tmp/ingress-auth-routes-to-api.yaml"
expect "ingress: /api/auth routed to api instead of web fails" 1 "$tmp/ingress-auth-routes-to-api.yaml"

# AUTH_URL missing entirely.
grep -v "AUTH_URL" "$tmp/ingress-ok.yaml" | grep -v 'value: "https://frontdesk.example.com"' > "$tmp/ingress-no-auth-url.yaml"
expect "ingress: AUTH_URL missing fails" 1 "$tmp/ingress-no-auth-url.yaml"

# AUTH_URL present but pointing at a different host than the Ingress serves
# (the literal shape of the production bug: some origin that isn't the
# real public one - here a stale/typo'd host rather than 0.0.0.0, since
# this check compares against the Ingress's own host, not a hardcoded
# string).
sed 's#https://frontdesk.example.com#https://wrong.example.com#' "$tmp/ingress-ok.yaml" > "$tmp/ingress-auth-url-mismatch.yaml"
expect "ingress: AUTH_URL host mismatch fails" 1 "$tmp/ingress-auth-url-mismatch.yaml"

if [ "$failures" -ne 0 ]; then
  echo "$failures test(s) failed" >&2
  exit 1
fi
echo "all check-manifest-refs tests passed"
