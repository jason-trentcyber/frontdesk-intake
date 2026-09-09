# deploy/bootstrap

In-cluster bootstrap for the k3s node (#16; ADR-0001 runtime, ADR-0002
ingress/cert-manager, ADR-0010 in-cluster scope). No Prometheus, Loki, or
Grafana here — those run off-node on the Hermes VPS (ADR-0010, #52). This
covers only: **ingress-nginx, cert-manager + ClusterIssuers, sealed-secrets,
and the observability namespace (otel-collector, node-exporter,
kube-state-metrics).**

Helmfile is not in the toolchain. `bootstrap.sh` is a plain, idempotent
`helm upgrade --install` per chart, pinned chart versions, one values file
per component under `values/`.

## Components

| Component | Namespace | Chart | Version |
|---|---|---|---|
| ingress-nginx | `ingress-nginx` | `ingress-nginx/ingress-nginx` | 4.15.1 |
| cert-manager | `cert-manager` | `jetstack/cert-manager` | v1.21.1 |
| sealed-secrets | `kube-system` | `sealed-secrets/sealed-secrets` | 2.19.3 |
| otel-collector | `observability` | `open-telemetry/opentelemetry-collector` | 0.172.1 |
| node-exporter | `observability` | `prometheus-community/prometheus-node-exporter` | 4.56.3 |
| kube-state-metrics | `observability` | `prometheus-community/kube-state-metrics` | 8.4.2 |

Chart/version pins live in `bootstrap.sh` and are duplicated in
`.github/workflows/ci.yml`'s `helm-lint` job (no shared registry to pull
them from at CI time); bump both together.

## Ingress data path

servicelb is disabled on this node (ADR-0001 cloud-init), so there is no
`LoadBalancer` to bind a Service to, and NodePort would put the app on a
30xxx port with a mapping layer in front. `values/ingress-nginx.yaml` runs
the controller as a **DaemonSet with `hostNetwork: true`**, bound directly
to the node's 80/443 — which the Hetzner firewall already restricts to
Cloudflare's published ranges (`infra/hetzner/main.tf`). **This is the k3s
values-file expression of ADR-0002's ingress-nginx decision, not a
different data path** — the identical chart runs as a `Deployment` behind a
real NLB on EKS. That swap is `deploy/values-eks.yaml`, layered on top of
this values file; nothing about the chart or the manifests it produces
changes, only `controller.kind`/`hostNetwork`/`service.type`.

`controller.config.use-forwarded-headers` and `real-ip-header:
CF-Connecting-IP` are set so app-level logs see the visitor's IP, not
Cloudflare's.

## TLS

cert-manager with Let's Encrypt via **DNS-01 through a Cloudflare API
token** — HTTP-01 cannot work here: 80/tcp is closed to everything but
Cloudflare's ranges by design (ADR-0002), and Let's Encrypt's HTTP-01
validators aren't Cloudflare. Two `ClusterIssuer`s in `cluster-issuers/`:

- `letsencrypt-staging` — default for the acceptance test below, no rate
  limits.
- `letsencrypt-prod` — real certs, rate-limited. The hello page (#18)
  switches to this one.

Both need a secret named `cloudflare-api-token` (key `api-token`) in the
`cert-manager` namespace, scoped to `Zone:DNS:Edit` + `Zone:Zone:Read` on
the `jtrent.dev` zone only. See **Secrets** below for how that secret gets
there — an agent never has the plaintext.

`test-certificate.yaml` is the acceptance-test `Certificate` (see below);
delete it once the check passes, it has no other purpose.

## Secrets

sealed-secrets controller runs in `kube-system`; `kubeseal` (CLI) runs
wherever a human has it installed — not in this repo, not run by an agent.

1. Jason fetches the controller's public cert (safe to commit, it's public
   key material): `kubeseal --fetch-cert > deploy/bootstrap/sealed-secrets-pub.pem`
2. Creates the Cloudflare API token secret **locally**, seals it against
   that cert, and commits the result:
   `deploy/bootstrap/cloudflare-api-token.sealed.yaml`. The plaintext token
   never touches the repo, an agent's context, or a PR.
3. `bootstrap.sh` applies the sealed file if present (`kubectl apply -f`),
   then the `ClusterIssuer`s that reference the secret it decrypts to.

**Back up the controller's private key** to the same off-host location as
the Terraform state (ADR-0012 pattern):

```
kubectl -n kube-system get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml
```

Losing it means re-sealing every secret in the repo.

## Resource budget

Every container has requests and limits (`docs/conventions.md`). Budget:
**≤ 600 Mi requests** total. `helm template` totals, summed across all six
components' rendered manifests (agent-verified — see below):

**requests.memory: 430 Mi** (limits.memory: 1336 Mi worst case, never all
hit at once). Split:

| Component | Requests | Limits |
|---|---|---|
| ingress-nginx controller | 90Mi | 256Mi |
| cert-manager (controller+webhook+cainjector) | 3×30Mi = 90Mi | 3×128Mi = 384Mi |
| sealed-secrets | 30Mi | 128Mi |
| otel-collector | 100Mi | 256Mi |
| node-exporter | 30Mi | 64Mi |
| kube-state-metrics | 30Mi | 128Mi |
| One-shot install/upgrade Jobs (ingress-nginx admission ×2, cert-manager startupapicheck) | 3×20Mi = 60Mi | 3×40Mi = 120Mi |

The three Jobs run once per install/upgrade and exit; they're bounded per
convention but aren't steady-state load (steady-state requests: 370 Mi).
Re-check against `kubectl top` after a real install and adjust the values
files if they drift.

## Network policies

`network-policies/observability-default-deny.yaml`: default-deny ingress
in the `observability` namespace (N4) — otel-collector, node-exporter, and
kube-state-metrics take no unsolicited inbound traffic; #52 adds a scoped
allow rule from the VPS once there's something on the other end. cert-manager
and ingress-nginx use their charts' own `networkPolicy.enabled: true` where
offered instead of a hand-written policy. Deeper policies land with the app
namespace in M3.

## Running it

```
make bootstrap        # KUBECONFIG=infra/hetzner/kubeconfig ./deploy/bootstrap/bootstrap.sh
```

Idempotent — re-running only applies what changed. Requires `helm` and
`kubectl` (both already on the Hermes VPS) and a kubeconfig pointed at the
cluster.

## RBAC for CI deploys (`#18`, ADR-0014)

`rbac/` is namespace + RBAC only — the `frontdesk` application namespace
that `deploy/chart/` installs into, and the least-privilege identity
GitHub Actions uses to deploy it. Applied **once**, by a human, with the
admin kubeconfig:

```
make bootstrap-rbac   # KUBECONFIG=infra/hetzner/kubeconfig kubectl apply -f deploy/bootstrap/rbac/
```

Contents: Namespace `frontdesk` (Pod Security Admission `enforce:
restricted`), ServiceAccount `deployer`, a `Role` scoped to exactly what
`helm upgrade --install --wait` touches (Deployments, Services, Ingresses,
ConfigMaps, Secrets, ServiceAccounts, NetworkPolicies, SealedSecrets, and
read-only Pods), and a `ClusterRole` granting `get` on the single
`frontdesk` Namespace object (Helm checks the namespace exists before
installing, since `deploy.yml` never passes `--create-namespace`). No
cluster-admin, nothing cross-namespace — see ADR-0014's rejected
alternatives for why.

**Minting the Actions secret**, after `make bootstrap-rbac`:

```
kubectl create token deployer -n frontdesk --duration=8760h > /tmp/deployer.token
```

Build a kubeconfig around that token pointed at the **tailnet** IP (not
the floating IP — `deploy.yml`'s runner joins the tailnet for the
duration of the run, ADR-0014), then base64 it and set the secret:

```
TOKEN=$(cat /tmp/deployer.token)
CA=$(kubectl config view --raw --minify --flatten -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
cat > /tmp/deployer.kubeconfig <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: frontdesk-node
    cluster:
      server: https://100.88.28.10:6443
      certificate-authority-data: ${CA}
contexts:
  - name: deployer
    context:
      cluster: frontdesk-node
      namespace: frontdesk
      user: deployer
current-context: deployer
users:
  - name: deployer
    user:
      token: ${TOKEN}
EOF
base64 -w0 /tmp/deployer.kubeconfig | gh secret set KUBECONFIG_B64
shred -u /tmp/deployer.token /tmp/deployer.kubeconfig
```

Rotate yearly (the token's `--duration`) or immediately on any suspicion
of leak — minting a fresh token and re-running `gh secret set` is the
entire rotation procedure; nothing else references the old one.

**Negative test** (confirms the token is namespace-scoped, not admin):

```
kubectl --kubeconfig /tmp/deployer.kubeconfig get pods -n kube-system   # Forbidden
kubectl --kubeconfig /tmp/deployer.kubeconfig get pods -n frontdesk     # allowed (empty until the first deploy)
```

## Acceptance (paste real output into the PR)

```
kubectl get pods -A                           # all Running/Completed, none restarting
kubectl get clusterissuer                     # both READY=True
kubectl apply -f deploy/bootstrap/test-certificate.yaml && \
  kubectl -n cert-manager wait certificate test-staging --for=condition=Ready --timeout=5m
kubeseal round-trip: seal a throwaway secret, apply, kubectl get secret shows the value, delete it
kubectl top node                              # memory < 1.5 Gi
kubectl -n observability get pods             # otel-collector, node-exporter, kube-state-metrics up
curl -sk https://<floating-ip>/ -H 'Host: frontdesk.jtrent.dev'   # from the VPS; 404 from nginx = data path works
```

Then `terraform plan` in `infra/hetzner` should still report **No
changes** — bootstrap must not need a firewall edit.

## Agent verification

Claude Code verifies with `helm lint` and `helm template` only (after
`helm repo add`ing the chart repos above to resolve the pinned versions).
No cluster access, no kubeconfig, no `helm install`, no `make bootstrap`.
`.github/workflows/ci.yml`'s `helm-lint` job runs the same lint/template
check on every PR, independent of `deploy/chart/`.

## Out of scope here

DNS record, Cloudflare proxy/WAF/rate-limit (#17). Hello page + CI deploy
job (#18). Tailscale on the node and OTel exporters to the VPS (#52 — the
node joined the tailnet in #57/#58, but #16 doesn't need it: DNS-01 goes
out to Cloudflare, not in). Postgres (#20).
