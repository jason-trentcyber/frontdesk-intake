#!/usr/bin/env bash
# Cross-resource reference check for a rendered Helm manifest.
#
# helm lint, helm template and kubeconform all validate resources one at a
# time, so a Deployment naming a ServiceAccount that no template emits is
# valid YAML, a valid Deployment, and passes every one of them - the failure
# only exists as a reference between two documents, which nothing resolves
# until the API server refuses to create the pod. That is exactly how #99
# shipped a worker Deployment whose ServiceAccount was never templated
# (serviceaccount.yaml had web and api blocks only): CI was green, and the
# deploy failed with
#
#   pods "frontdesk-worker-..." is forbidden: error looking up service
#   account frontdesk/frontdesk-worker: serviceaccount ... not found
#
# Same class as the #18/#65 Dockerfile `USER <name>` vs runAsNonRoot bug:
# schema-valid, admission-invalid. And the same class again as the 26a
# follow-up (#26) Ingress bug this file's second and third checks exist
# for: a `path: /api` Prefix rule routing Auth.js's own /api/auth/*
# endpoints to Fastify instead of web is valid YAML, a valid Ingress, and
# invisible to every test that drives the Next server directly
# (Playwright never goes through this Ingress at all) - it only breaks
# once a real request crosses the real ingress-nginx routing this file
# checks without a cluster.
#
# Usage: check-manifest-refs.sh <rendered-manifest.yaml>
set -euo pipefail

manifest="${1:?usage: check-manifest-refs.sh <rendered-manifest.yaml>}"
[ -r "$manifest" ] || { echo "not readable: $manifest" >&2; exit 2; }

status=0

# --- Check 1: every serviceAccountName a pod template asks for is emitted ---
#
# Parsing is by YAML shape, not with a parser, to avoid adding a dependency to
# the helm-lint job. Two assumptions, both true of every template in this chart
# and both pinned by check-manifest-refs.test.sh:
#
#   1. A ServiceAccount's metadata.name is the first 2-space-indented `name:`
#      line after its `kind: ServiceAccount`. Reordering metadata so that
#      another 2-space `name:` comes first would break this.
#   2. Any `serviceAccountName:` at any indentation is a pod-template field.
#      No other Kubernetes field shares that name today.
#
# If a future template violates either, the test fixtures stop failing where
# they should - which is the signal to switch to a real YAML parser.

# Names of every ServiceAccount the chart actually emits.
emitted="$(awk '
  /^kind: ServiceAccount$/ { want = 1; next }
  want && /^  name: / { sub(/^  name: /, ""); print; want = 0 }
' "$manifest" | sort -u)"

# Every ServiceAccount a pod template asks for, at any indentation.
referenced="$(sed -n 's/^[[:space:]]*serviceAccountName:[[:space:]]*//p' "$manifest" \
  | tr -d '"' | sort -u)"

while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  # "default" always exists in a namespace and is never templated.
  [ "$ref" = "default" ] && continue
  if ! printf '%s\n' "$emitted" | grep -qxF "$ref"; then
    echo "ERROR: serviceAccountName: $ref is referenced but no ServiceAccount with that name is rendered ($manifest)" >&2
    status=1
  fi
done <<< "$referenced"

if [ "$status" -eq 0 ]; then
  echo "serviceAccountName refs OK ($(printf '%s\n' "$referenced" | grep -c . || true) referenced, $(printf '%s\n' "$emitted" | grep -c . || true) emitted)"
fi

# --- Checks 2 and 3: only apply to a manifest that has an Ingress at all ---
#
# The chart's own `helm template` output always does, but check-manifest-
# refs.test.sh's minimal Check-1-only fixtures (and any future caller that
# renders a partial manifest) don't - and "no Ingress in this manifest" is
# not the bug either check exists to catch, so it's a skip, not a failure.
if ! grep -q '^kind: Ingress$' "$manifest"; then
  echo "no Ingress in $manifest - skipping ingress routing and AUTH_URL checks"
  exit "$status"
fi

# --- Check 2: the Ingress routes /api/auth and / to web, /api to api ---
#
# Same shape-based approach: track which Service (by name) is found inside
# each `kind: Service` document by looking for its component label
# (`app.kubernetes.io/component: web`/`api`) - derived from the manifest
# itself, not a hardcoded "frontdesk-web"/"frontdesk-api" string, so a
# future rename of the fullname helper doesn't make this check pass for the
# wrong reason. Assumes each Service's `metadata.name` line precedes its
# `metadata.labels` block, true of every Service template in this chart.
web_service="$(awk '
  /^kind: Service$/ { in_svc = 1; svc_name = ""; next }
  /^---/ { in_svc = 0 }
  in_svc && svc_name == "" && /^  name: / { svc_name = $0; sub(/^  name: /, "", svc_name) }
  in_svc && /app\.kubernetes\.io\/component: web$/ { print svc_name; exit }
' "$manifest")"
api_service="$(awk '
  /^kind: Service$/ { in_svc = 1; svc_name = ""; next }
  /^---/ { in_svc = 0 }
  in_svc && svc_name == "" && /^  name: / { svc_name = $0; sub(/^  name: /, "", svc_name) }
  in_svc && /app\.kubernetes\.io\/component: api$/ { print svc_name; exit }
' "$manifest")"

if [ -z "$web_service" ] || [ -z "$api_service" ]; then
  echo "ERROR: could not find a web and/or api Service in $manifest (web=$web_service api=$api_service)" >&2
  status=1
else
  # path -> backend service name, in the order the Ingress declares them.
  declare -A ingress_backend=()
  while IFS=$'\t' read -r path svc; do
    [ -n "$path" ] || continue
    ingress_backend["$path"]="$svc"
  done < <(awk '
    /^---/ { in_ingress = 0 }
    /^kind: Ingress$/ { in_ingress = 1 }
    in_ingress && /^[[:space:]]*- path: / {
      path = $0; sub(/^[[:space:]]*- path: /, "", path)
    }
    in_ingress && path != "" && /^[[:space:]]*name: / {
      svc = $0; sub(/^[[:space:]]*name: /, "", svc)
      print path "\t" svc
      path = ""
    }
  ' "$manifest")

  check_route() {
    local path="$1" want="$2" got="${ingress_backend[$1]:-}"
    if [ -z "$got" ]; then
      echo "ERROR: no Ingress rule for path $path in $manifest (expected backend $want)" >&2
      status=1
    elif [ "$got" != "$want" ]; then
      echo "ERROR: Ingress path $path routes to $got, expected $want ($manifest)" >&2
      status=1
    fi
  }
  # Auth.js's /api/auth/* endpoints live in web/, not api/ (26a follow-up,
  # #26) - this is the specific rule the whole check exists to pin.
  check_route "/api/auth" "$web_service"
  check_route "/api" "$api_service"
  check_route "/" "$web_service"

  if [ "$status" -eq 0 ]; then
    echo "Ingress routing OK (/api/auth -> $web_service, /api -> $api_service, / -> $web_service)"
  fi
fi

# --- Check 3: web's Deployment sets AUTH_URL from the Ingress's own host ---
#
# A cross-resource check in the literal sense: the value web's container env
# sets for AUTH_URL must equal "https://" plus the same host the Ingress
# resource (rendered right above) actually serves - not just "present",
# which would pass even if it silently drifted from the real public origin.
#
# Scoped to the Deployment document whose component label is "web" (same
# shape as Check 2's Service scoping), not the first "name: AUTH_URL" found
# anywhere in the manifest - a second, unrelated AUTH_URL reference added
# elsewhere in the future (api/ or worker/ have no reason to need one today,
# but nothing stops a future template from adding one) would otherwise be
# able to satisfy this check while web's own value silently drifted wrong.
ingress_host="$(awk '/^kind: Ingress$/ { f = 1 } f && /^[[:space:]]*- host: / { sub(/^[[:space:]]*- host: /, ""); print; exit }' "$manifest")"
auth_url_value="$(awk '
  /^---/ { in_deploy = 0; is_web = 0 }
  /^kind: Deployment$/ { in_deploy = 1 }
  in_deploy && /app\.kubernetes\.io\/component: web$/ { is_web = 1 }
  in_deploy && is_web && /name: AUTH_URL$/ { want = 1; next }
  want { print; exit }
' "$manifest" | sed -n 's/^[[:space:]]*value: "\(.*\)"$/\1/p')"

if [ -z "$ingress_host" ]; then
  echo "ERROR: could not find the Ingress host in $manifest" >&2
  status=1
elif [ -z "$auth_url_value" ]; then
  echo "ERROR: AUTH_URL is not set in web's Deployment env in $manifest" >&2
  status=1
elif [ "$auth_url_value" != "https://${ingress_host}" ]; then
  echo "ERROR: AUTH_URL is '$auth_url_value', expected 'https://${ingress_host}' to match the Ingress host ($manifest)" >&2
  status=1
else
  echo "AUTH_URL OK (https://${ingress_host})"
fi

exit "$status"
