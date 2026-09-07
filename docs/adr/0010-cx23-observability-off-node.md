# ADR-0010: Node is a Hetzner cx23 (4 GB); observability runs off-node on the Hermes VPS

Status: decided 2026-09-07. Supersedes ADR-0009 (never applied) and the node-type clause of ADR-0001. Amends ADR-0001's observability placement.

## Context
At first `terraform apply` on 2026-09-07, Hetzner rejected `cax21` in every location ("unsupported location for server type") even though the `/datacenters` endpoint reported it available; a direct create probe confirmed the API's availability data was wrong and the console was right. The only 8 GB shared type that actually created was `cpx32` at €41.99/mo, four times the budget in REQUIREMENTS N6. `cx23` (x86, 2 vCPU / 4 GB / 40 GB, €6.49) created fine in nbg1.

A 4 GB node fits the application (k3s ~1 GB, ingress+cert-manager ~0.3, Postgres ~0.7, web+api ~0.4, worker with bge-small ~0.7 = ~3.1 GB) but not the application plus kube-prometheus-stack, Loki, and Grafana (~2 GB more).

## Decision
- Node: `cx23` in `nbg1`. €6.49/mo plus floating IP (~€0.60). Provisioned by the existing `infra/hetzner` root; `terraform apply` ran from the VPS.
- Observability stack (Prometheus, Loki, Grafana, Alertmanager) runs on the existing Hermes VPS (`trentcyber-main`, ~3 GB free), not in the cluster. The cluster runs only an OpenTelemetry collector and node/kube-state exporters, which ship metrics and logs to the VPS over a WireGuard/Tailscale link (Tailscale is being added to both hosts regardless).
- The ops agent (REQUIREMENTS S6, #32) reads alerts and logs from Prometheus/Loki on the VPS it already runs on, and reads cluster state through the read-only kubeconfig. This removes the cross-host hop the original design needed.
- Kubernetes API (6443) is opened only to the same admin sources as SSH; the CI deploy job reaches the cluster via the VPS until Tailscale replaces the IP allowlist.
- Resource limits in the chart are sized for a 4 GB node: total requests must stay under ~2.8 GB; the eval harness and reindex jobs run as Kubernetes Jobs, not always-on pods.

## Consequences
- `deploy/chart/` does not include kube-prometheus-stack or Loki. `#21` (bootstrap) shrinks to ingress-nginx, cert-manager, sealed-secrets, OTel collector, exporters. A new issue covers the VPS-side observability compose stack.
- `values-eks.yaml` documents the swap back to in-cluster observability (or CloudWatch/AMP) as a values-level change; the app emits OTLP either way, so the app is unchanged.
- Embedding throughput is lower on 2 vCPU: ingestion of a few hundred chunks per org is seconds to a minute, acceptable for v1; the F9 10 s p95 draft target is unaffected (drafting is an API call).
- If Hetzner restocks an 8 GB type under €15 or the project moves to another provider (Netcup was the named fallback), the change is `server_type` and re-bootstrap; nothing in the chart assumes 4 GB.
- Cost line: node + floating IP ≈ €7.10/mo, below the original ~€8 estimate.

## Rejected
- `cpx32` (€41.99): 4× the budget for a demo; no architectural benefit.
- `ccx13` dedicated (€50.49): same.
- Grafana Cloud free tier for observability: workable and generous, but a new vendor in the core path when a self-hosted option exists on hardware already paid for. Kept as the fallback if the VPS gets tight.
- Waiting for `cx33`/`cax21` restock: indefinite; the project was blocked on this for an hour already.
- Dropping observability (N3) entirely: guts the dashboards and the ops-loop story, which are the differentiator.
