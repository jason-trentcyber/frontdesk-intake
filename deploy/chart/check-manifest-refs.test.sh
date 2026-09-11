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

if [ "$failures" -ne 0 ]; then
  echo "$failures test(s) failed" >&2
  exit 1
fi
echo "all check-manifest-refs tests passed"
