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
# schema-valid, admission-invalid.
#
# Usage: check-manifest-refs.sh <rendered-manifest.yaml>
set -euo pipefail

manifest="${1:?usage: check-manifest-refs.sh <rendered-manifest.yaml>}"
[ -r "$manifest" ] || { echo "not readable: $manifest" >&2; exit 2; }

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

status=0
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
exit "$status"
