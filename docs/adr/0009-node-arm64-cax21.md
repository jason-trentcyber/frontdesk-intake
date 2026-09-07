# ADR-0009: Node is a Hetzner cax21 (Ampere ARM64), superseding the CX32 choice in ADR-0001

Status: decided 2026-09-07. Supersedes the server-type and architecture clause of ADR-0001; the rest of ADR-0001 stands.

## Context
ADR-0001 sized the node as a CX32 (x86, 4 vCPU / 8 GB, ~€8/mo). On 2026-09-07, at first `terraform plan`, CX32 was discontinued and its successor cx33 (€9.99) had no stock in any Hetzner location (checked via the datacenters API, not just the console). Options with stock at 8 GB: cax21 (ARM64, €12.49), cpx31 (x86, €20.49), cpx32 (x86, €41.99). 8 GB is the floor once kube-prometheus-stack and Loki run alongside Postgres and the app (~5–5.5 GB idle), so dropping to a 4 GB x86 box would mean cutting requirement N3.

## Decision
- Node: `cax21` (Ampere Altra ARM64, 4 vCPU / 8 GB / 80 GB) in `nbg1`. €12.49/mo plus floating IP.
- Application images are built arm64-native in GitHub Actions on `ubuntu-24.04-arm` runners (free for public repos). No QEMU emulation, no multi-arch manifests in v1.
- Every third-party image or chart must publish arm64. Verified at decision time: k3s, the `ghcr.io/pgmq/pg16-pgmq` base (pgvector compiles from source), ingress-nginx, cert-manager, sealed-secrets, kube-prometheus-stack, Loki, OTel collector, Node and Python base images, PyTorch aarch64 wheels for bge-small.
- Local development stays x86 (`compose.yaml` pulls x86 images). This is a feature: the Helm chart cannot rely on architecture, which is the same discipline an EKS Graviton node group would demand.

## Consequences
- `deploy.yml` (#18) runs on `ubuntu-24.04-arm`. `values-eks.yaml` documents `nodeSelector: kubernetes.io/arch` as a knob rather than assuming amd64.
- Anything run by hand on the cluster (`kubectl run`, debug pods) needs an arm64 image.
- CI integration tests (LocalStack, Postgres service containers) still run x86 on the default runners; that is accepted since CI tests behavior, not architecture.
- Cost line in REQUIREMENTS N6 becomes ~€13/mo for the node, not ~€8.

## Rejected
- cpx31/cpx32 (x86): 1.6× to 3.4× the price for the same RAM, no engineering benefit.
- cx23 (x86, 4 GB): below the memory floor with observability on; would gut the dashboards and the ops-loop story.
- Waiting for cx33 restock: unknown timeline for €2.50/mo.
- Provisioning by hand in the Hetzner console: makes `infra/hetzner` decorative and violates N1.
- Another provider: new vendor signup, which the project avoids in v1.
