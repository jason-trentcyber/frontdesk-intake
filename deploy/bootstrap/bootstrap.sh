#!/usr/bin/env bash
# In-cluster bootstrap for #16 (ADR-0001, ADR-0002, ADR-0010): ingress-nginx,
# cert-manager + ClusterIssuers, sealed-secrets, and the observability
# namespace (otel-collector, node-exporter, kube-state-metrics). No
# Helmfile in the toolchain — plain `helm upgrade --install` per chart,
# pinned versions, one values file per component. Idempotent: safe to
# re-run.
#
# Run via `make bootstrap` (sets KUBECONFIG=infra/hetzner/kubeconfig).
# Requires: helm, kubectl, and the Cloudflare API token already sealed and
# committed as deploy/bootstrap/cloudflare-api-token.sealed.yaml (README.md
# "Secrets" section) — the ClusterIssuers apply without it but stay stuck
# in a pending state until it exists.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALUES_DIR="$SCRIPT_DIR/values"

: "${KUBECONFIG:?KUBECONFIG must point at the cluster kubeconfig (see infra/hetzner/README.md)}"

INGRESS_NGINX_VERSION="4.15.1"
CERT_MANAGER_VERSION="v1.21.1"
SEALED_SECRETS_VERSION="2.19.3"
OTEL_COLLECTOR_VERSION="0.172.1"
NODE_EXPORTER_VERSION="4.56.3"
KUBE_STATE_METRICS_VERSION="8.4.2"

echo "==> Adding chart repos"
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update
helm repo add jetstack https://charts.jetstack.io --force-update
helm repo add sealed-secrets https://bitnami.github.io/sealed-secrets --force-update
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts --force-update
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update
helm repo update

echo "==> Namespaces"
for ns in ingress-nginx cert-manager observability; do
  kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -
done

echo "==> ingress-nginx ($INGRESS_NGINX_VERSION)"
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --version "$INGRESS_NGINX_VERSION" \
  --namespace ingress-nginx \
  -f "$VALUES_DIR/ingress-nginx.yaml" \
  --wait

echo "==> cert-manager ($CERT_MANAGER_VERSION)"
helm upgrade --install cert-manager jetstack/cert-manager \
  --version "$CERT_MANAGER_VERSION" \
  --namespace cert-manager \
  -f "$VALUES_DIR/cert-manager.yaml" \
  --wait

echo "==> sealed-secrets ($SEALED_SECRETS_VERSION)"
helm upgrade --install sealed-secrets sealed-secrets/sealed-secrets \
  --version "$SEALED_SECRETS_VERSION" \
  --namespace kube-system \
  -f "$VALUES_DIR/sealed-secrets.yaml" \
  --wait

echo "==> otel-collector ($OTEL_COLLECTOR_VERSION)"
helm upgrade --install otel-collector open-telemetry/opentelemetry-collector \
  --version "$OTEL_COLLECTOR_VERSION" \
  --namespace observability \
  -f "$VALUES_DIR/otel-collector.yaml" \
  --wait

echo "==> node-exporter ($NODE_EXPORTER_VERSION)"
helm upgrade --install node-exporter prometheus-community/prometheus-node-exporter \
  --version "$NODE_EXPORTER_VERSION" \
  --namespace observability \
  -f "$VALUES_DIR/node-exporter.yaml" \
  --wait

echo "==> kube-state-metrics ($KUBE_STATE_METRICS_VERSION)"
helm upgrade --install kube-state-metrics prometheus-community/kube-state-metrics \
  --version "$KUBE_STATE_METRICS_VERSION" \
  --namespace observability \
  -f "$VALUES_DIR/kube-state-metrics.yaml" \
  --wait

echo "==> Network policies"
kubectl apply -f "$SCRIPT_DIR/network-policies/"

echo "==> Cloudflare API token (sealed secret)"
SEALED_TOKEN="$SCRIPT_DIR/cloudflare-api-token.sealed.yaml"
if [ -f "$SEALED_TOKEN" ]; then
  kubectl apply -f "$SEALED_TOKEN"
else
  echo "WARNING: $SEALED_TOKEN not found — seal and commit it first (README.md" >&2
  echo "'Secrets' section), then re-run this script. ClusterIssuers below" >&2
  echo "will apply but stay pending until that secret exists." >&2
fi

echo "==> ClusterIssuers"
kubectl apply -f "$SCRIPT_DIR/cluster-issuers/"

echo "==> Bootstrap complete. Acceptance checks: see README.md."
