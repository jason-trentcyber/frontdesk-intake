# deploy/chart

The `frontdesk` Helm chart: one chart, one release, for every workload
(ADR-0001). `#18` ships only the `web` component (the hello page);
`api`/`worker` land as their own Deployments in this same chart with
`#22`/`#23`.

`values.yaml` is k3s-agnostic — nothing in it or in `templates/` names
k3s, Hetzner, or Cloudflare (`docs/conventions.md` → Infra). Platform
deltas are values-only:

- `values-hetzner.yaml` — live. Nothing extra today; the defaults already
  work on k3s (ingress-nginx class `nginx` is identical on both
  platforms, ADR-0002).
- `values-eks.yaml` — documented swap, never applied in v1 (`infra/aws/`
  is validate-only). This is the **application chart's** EKS delta —
  distinct from the top-level `../values-eks.yaml`, which is the
  `#16`/`#17` bootstrap layer's own delta (the ingress-nginx controller's
  Service type).

## Install / upgrade

Always pin the image by digest (ADR-0014) — never a mutable tag:

```
helm upgrade --install frontdesk deploy/chart \
  -n frontdesk \
  -f deploy/chart/values-hetzner.yaml \
  --set web.image.digest=sha256:<digest> \
  --wait --timeout 5m --history-max 5
```

`deploy.yml` runs exactly this after every push to `main` (once CI is
green), with `<digest>` set to the image `docker/build-push-action` just
pushed to GHCR. The namespace and RBAC this needs already exist —
`deploy/bootstrap/rbac/` (`make bootstrap-rbac`), run once by a human.

## Rollback

Helm keeps release history (`--history-max 5` above):

```
helm history frontdesk -n frontdesk
helm rollback frontdesk <revision> -n frontdesk
```

Run from wherever the deploy job runs — the tailnet, via the same
`deployer` ServiceAccount kubeconfig (ADR-0014). A rollback does not
revert the Docker image in GHCR, only which digest the Deployment points
at; the image itself is immutable once pushed.

## Secrets

The chart references an existing `Secret` (`turnstile`, key `secret-key`)
via `env.valueFrom` on the `web` container but does not create it —
`sealed/README.md` has the exact `kubeseal` command. `secretKeyRef` is
`optional: true` so the `web` Deployment isn't blocked on that secret
existing (`#27`, the public form, is the first thing that actually reads
it). The public Turnstile site key is not a secret and ships as a
`ConfigMap` value straight from `values.yaml`.

## Resource budget

`web`: requests 128Mi/50m, limits 256Mi/250m, 1 replica. Counted against
the node's ~2.8 GB total-requests budget (ADR-0010) alongside the
bootstrap layer's ~370 Mi steady-state (`deploy/bootstrap/README.md`).

## Security posture

`web` Pod: `runAsNonRoot`, `seccompProfile: RuntimeDefault`. Container:
`allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true` (the
Next.js standalone server writes nothing at runtime — verified by running
the built image with `--read-only`), all capabilities dropped. `NetworkPolicy`
allows ingress only from the `ingress-nginx` namespace; default-deny
otherwise (N4). The `ServiceAccount` has `automountServiceAccountToken: false` —
the pod has no reason to call the Kubernetes API.

## Agent verification

Claude Code verifies with `helm lint`, `helm template`, and `kubeconform`
(against the Kubernetes 1.36 schemas, matching the cluster's k3s version)
for both values files. No cluster access, no kubeconfig, no secrets
created — see `.github/workflows/ci.yml`'s `helm-lint` job for the exact
commands CI runs on every PR.
