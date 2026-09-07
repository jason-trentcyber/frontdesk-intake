# ADR-0001: Runtime is k3s on a Hetzner Cloud box, deployed by a portable Helm chart

Status: decided 2026-09-07

## Context
Resume and posting emphasize Kubernetes, AWS, IaC. Budget is a hobby budget; managed EKS costs ~$73/mo for the control plane alone before nodes. Jason already pays for Hetzner.

## Decision
- Terraform (hcloud provider) provisions one 4 vCPU / 8 GB shared server, firewall, and a floating IP. Originally CX32 (x86, ~€8/mo). **Amended 2026-09-07:** CX32 is discontinued and its successor cx33 (€9.99) was out of stock in every location; the node is now **cax21 (Ampere ARM64, 4 vCPU / 8 GB, €12.49/mo)** in nbg1. Consequence: all application images are built arm64-native on GitHub's `ubuntu-24.04-arm` runners; every third-party chart/image used must publish arm64 (verified for pgmq/pgvector base, ingress-nginx, cert-manager, kube-prometheus-stack, Loki). Local dev stays x86, which keeps the chart honest about architecture, the same discipline EKS Graviton would demand. Cloud-init installs k3s with Traefik and servicelb disabled.
- All workloads deploy via one Helm chart at `deploy/chart/`. The chart contains no k3s-specific resources.
- `deploy/values-hetzner.yaml` is live. `deploy/values-eks.yaml` documents the swap: ingress class, storage class (gp3), IRSA annotations, `QUEUE_PROVIDER=sqs`, `LLM_PROVIDER=bedrock`. `infra/aws/` holds a Terraform root for EKS that is `terraform validate`d in CI but never applied.
- Hermes stays on the existing VPS, not on the cluster.

## Consequences
- One node, no HA. Acceptable for a demo; stated in the README.
- Memory budget on the node: Postgres ~1 GB, kube-prometheus-stack+Loki ~2 GB, app services ~1.5 GB. Tight; resource limits are mandatory in the chart.
- EKS portability is verified by lint and validate, not by a live apply, until an AWS account exists.

## Rejected
- ECS/Fargate: not Kubernetes, weaker portability story.
- Docker Compose on the VPS: no k8s story at all.
- Running on the Hermes VPS: 7.6 GB shared with Hermes is not enough.
