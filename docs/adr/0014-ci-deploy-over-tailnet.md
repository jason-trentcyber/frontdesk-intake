# ADR-0014: CI deploys reach the cluster over the tailnet; kubeconfig is a namespace-scoped ServiceAccount

Status: decided 2026-09-08. Refines ADR-0010 ("the CI deploy job reaches the cluster via the VPS until Tailscale replaces the IP allowlist") and ADR-0013 (admin access over the tailnet). Does not amend either.

## Context
REQUIREMENTS N5: "Deploy on merge to `main` via GitHub Actions to the cluster." Issue #18 says "`helm upgrade --install` with a scoped kubeconfig secret." Since ADR-0013 the Kubernetes API (6443) is reachable from exactly two places: the Hermes VPS's public IP and the tailnet. A GitHub-hosted runner is neither, so a kubeconfig in an Actions secret cannot connect to anything on its own. ADR-0010 deferred this with "via the VPS"; #18 has to pick.

The cluster is one 4 GB node with ~2.4 GB free after bootstrap (#16). The tailnet already holds the node as `tag:frontdesk-node`, joined with a tagged key; ACLs are the only thing between a tailnet peer and 6443.

## Decision
- **The deploy job joins the tailnet for the duration of the run** using `tailscale/github-action` with an **OAuth client** (scope `auth_keys`, tag `tag:ci`), ephemeral node, then runs `helm upgrade --install` against `https://100.88.28.10:6443` and leaves. Tailscale ACL: `tag:ci` → `tag:frontdesk-node:6443` only.
- **The kubeconfig in Actions is a ServiceAccount token, not the admin kubeconfig.** Namespace `frontdesk`; SA `deployer`; a `Role` granting the verbs Helm needs on the workload kinds in that namespace (Deployment, Service, Ingress, ConfigMap, Secret, ServiceAccount, and the Helm release Secrets), plus a `ClusterRole` for `get` on Namespaces only. No cluster-admin, no cross-namespace. The token is minted with `kubectl create token deployer -n frontdesk --duration=8760h`, stored as `KUBECONFIG_B64`, and rotated yearly or on suspicion; the kubeconfig's `server` is the tailnet IP (which is in the k3s SAN since #57), so the secret is useless off the tailnet.
- **Images go to GHCR** (`ghcr.io/jason-trentcyber/frontdesk-*`), built with `docker/build-push-action`, pinned by **digest** in the Helm release (`--set image.digest=…`), never by mutable tag. GHCR is free for public repos and needs no new account; `GITHUB_TOKEN` with `packages: write` is the push credential.
- **Push, not pull.** No GitOps controller (Argo CD, Flux) in v1: one app, one cluster, one operator; a controller is ~150 Mi+ on a node where every Mi is budgeted (ADR-0010). Revisit as a superseding ADR when there is a second environment or a second app.
- **Secrets the app needs at runtime** (Turnstile secret first) are SealedSecrets in `deploy/chart/` or `deploy/bootstrap/`, sealed by Jason for namespace `frontdesk`, applied by the same Helm release. Nothing plaintext ever passes through Actions.
- `values-eks.yaml` documents the swap: on EKS the job would use `aws-actions/configure-aws-credentials` + `aws eks update-kubeconfig` (OIDC, no tailnet) and `service.type: LoadBalancer`. Same chart, same job shape, different auth step.

## Consequences
- Long-lived Actions secrets: `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` (mint ephemeral tag:ci nodes only), `KUBECONFIG_B64` (namespace-scoped, tailnet-only). Blast radius of a leak: deploy into `frontdesk` from inside the tailnet. Not: read other namespaces, touch the node, reach the VPS.
- Each deploy leaves an ephemeral `github-…` device in the Tailscale admin for a few minutes; that is normal and visible.
- The 22/6443 "via the VPS" hedge in ADR-0010 is retired for CI; the VPS IP on 6443 remains the human break-glass path (ADR-0013).
- `deploy.yml` runs on `push` to `main` only, after `ci.yml` is green (`workflow_run` or job dependency), with `concurrency` so two merges cannot race a Helm release.
- Rollback is `helm rollback frontdesk` from the VPS; Helm keeps history (`--history-max 5`).

## Rejected
- **Self-hosted runner on the Hermes VPS.** Already inside the firewall, so the simplest; but it puts GitHub-scheduled execution on the host holding Hermes's credentials and the Terraform state. A runner in the cluster has the same problem one hop closer.
- **Open 6443 to GitHub's published IP ranges.** Thousands of CIDRs, changes weekly, and it re-opens the API to a shared public cloud after ADR-0013 closed it.
- **Deploy over SSH to the node** (`ssh root@node kubectl apply`). Gives CI root on the node to deploy an app.
- **Pull-based GitOps now.** Right for a fleet; a second controller for one Deployment on a 4 GB node. Deferred, not rejected forever.
- **Admin kubeconfig in Actions.** One leaked secret = the cluster. The SA token costs ten lines of RBAC.
- **Docker Hub / a Hetzner registry.** New account or new service; GHCR is already attached to the repo and free.
