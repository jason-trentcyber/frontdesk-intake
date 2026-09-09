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

`postgres-credentials` (keys `postgres-password`, `frontdesk-password`,
`frontdesk-app-password`) is the same pattern, referenced by the
`postgres` StatefulSet - not `optional: true`, since the database can't
start without it. Not sealed by an agent; see `sealed/README.md`.

## Postgres

`postgres.enabled` (default `true`, `false` in `values-eks.yaml`) gates a
whole StatefulSet's worth of resources: the `frontdesk-postgres`
StatefulSet itself, its two Services (headless + ClusterIP), the config
and connection ConfigMaps, the backups PVC, the nightly backup CronJob,
and postgres's own NetworkPolicy. `helm upgrade` on an unchanged
StatefulSet is a no-op, so ordinary `web`-only deploys never touch it.
On EKS the swap is `postgres.enabled: false` plus an externally supplied
`database.externalSecretName` (RDS) - none of the resources above render
at all; see `values-eks.yaml`'s comments. Full detail (roles, backups,
restore runbook) is in `deploy/postgres/README.md`.

**One node, no HA.** A restart on every image bump (a few times a year);
at most 24 h of data loss between nightly dumps (ADR-0016). Acceptable
for data that is fictional or purged within 24 h by requirement
(ADR-0007, N7) - the trigger for revisiting is a paying org's data or a
second node.

**Bumping the image:** edit the `ARG` defaults at the top of
`deploy/postgres/Dockerfile` (`PG_MINOR`/`PGVECTOR_VERSION`/`PGMQ_VERSION`),
open a PR the same shape as the one that first published this image -
`postgres-image.yml` builds, refuses to overwrite an existing tag, and
prints the new digest in the job summary - then copy that digest into
`postgres.image.digest` (and `postgres.image.tag`, to keep the values
file readable) in a second PR that touches only `deploy/chart/values.yaml`.
`deploy.yml` never rebuilds or re-pins this image the way it does `web`'s;
the pin only ever changes in a deliberate image-bump PR.

## Resource budget

`web`: requests 128Mi/50m, limits 256Mi/250m, 1 replica.
`postgres`: requests 256Mi/100m, limits 1Gi/1000m, 1 replica - the
backup CronJob's pod uses the same request/limit numbers, but only while
it runs (a few seconds nightly), not steady-state.

Steady-state chart total: **384Mi requests** (web + postgres). Counted
against the node's ~2.8 GiB total-requests budget (ADR-0010) alongside
the bootstrap layer's ~370 Mi steady-state
(`deploy/bootstrap/README.md`) - **~754Mi of ~2867Mi**, with the nightly
backup CronJob adding a further 256Mi only during its own run window
(worst case ~1010Mi, still well under budget).

## Security posture

`web` Pod: `runAsNonRoot`, `seccompProfile: RuntimeDefault`. Container:
`allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true` (the
Next.js standalone server writes nothing at runtime — verified by running
the built image with `--read-only`), all capabilities dropped. `NetworkPolicy`
allows ingress only from the `ingress-nginx` namespace; default-deny
otherwise (N4). The `ServiceAccount` has `automountServiceAccountToken: false` —
the pod has no reason to call the Kubernetes API.

`postgres` Pod: `runAsNonRoot`, `runAsUser`/`runAsGroup`/`fsGroup: 999`
(the pgvector base image's own `postgres` system user - confirmed, not
assumed; see `deploy/postgres/Dockerfile`'s header), `seccompProfile:
RuntimeDefault`, all capabilities dropped, `automountServiceAccountToken:
false`. **Exception:** `readOnlyRootFilesystem: false` (ADR-0016) —
Postgres writes outside the paths this chart gives a dedicated volume;
covering every write path individually cost more than it's worth for a
single-instance database pod. `NetworkPolicy` allows ingress to 5432
only from same-namespace pods labeled `app.kubernetes.io/part-of:
frontdesk` — every component's pod template carries that label
(including `web`'s, added for exactly this) so the convention holds as
more components land.

## Agent verification

Claude Code verifies with `helm lint`, `helm template`, and `kubeconform`
(against the Kubernetes 1.36 schemas, matching the cluster's k3s version)
for both values files. No cluster access, no kubeconfig, no secrets
created — see `.github/workflows/ci.yml`'s `helm-lint` job for the exact
commands CI runs on every PR.
