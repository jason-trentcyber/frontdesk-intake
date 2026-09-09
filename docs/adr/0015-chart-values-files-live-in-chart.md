# ADR-0015: Application-chart values overlays live inside `deploy/chart/`; RBAC amendment to ADR-0014

Status: decided 2026-09-09. RBAC list extended by ADR-0016 (StatefulSet, PVC without delete, CronJob/Job) for the database. Supersedes the file-path portion of ADR-0001 only — the decision itself (one portable Helm chart, plus a live values overlay and a documented EKS values overlay) is unchanged, only where the two overlay files live. Also documents, without amending, the full RBAC surface ADR-0014 introduced in outline.

## Context

ADR-0001 says: "`deploy/values-hetzner.yaml` is live. `deploy/values-eks.yaml` documents the swap." At the time ADR-0001 was written, `deploy/chart/` was the only thing under `deploy/`, so a top-level path was unambiguous.

Since then, `deploy/bootstrap/` (#16) grew its own top-level `deploy/values-eks.yaml`, documenting the ingress-nginx Service-type swap (`Deployment` + `LoadBalancer`/NLB instead of a `hostNetwork` DaemonSet) for the *bootstrap* layer — a `docs/conventions.md` layout entry and a `CLAUDE.md` ADR-map row exist for it already. That file's schema (raw `ingress-nginx` chart values) has nothing to do with the *application* chart's values.

#18 then built the real `deploy/chart/` and, to avoid a second, colliding `deploy/values-eks.yaml`, put the application chart's overlays at `deploy/chart/values-hetzner.yaml` and `deploy/chart/values-eks.yaml` instead — inside the chart directory, next to `values.yaml`. This matches `docs/conventions.md`'s repo-layout block, which already lists them nested under `deploy/chart/`. ADR-0001's text, read literally, still points at the top level and now reads as wrong for the application chart specifically. The review agent flagged this ambiguity on #64.

Separately, ADR-0014 sketched the deploy ServiceAccount's `Role` as covering "Deployment, Service, Ingress, ConfigMap, Secret, ServiceAccount, and the Helm release Secrets" plus a `ClusterRole` for `get` on Namespaces. Building the real chart and RBAC in #18 surfaced verbs ADR-0014's prose didn't name: `helm --wait` reads a Deployment's `ReplicaSet` to know when a rollout finished (a review-agent finding on #64 caught this omission — the Role was Forbidden without it), and the chart's own templates need `NetworkPolicy` and `SealedSecret` objects, which #18's `Role` already granted but ADR-0014 never enumerated. Nothing about the *decision* in ADR-0014 (tailnet join, SA-scoped kubeconfig, GHCR by digest, push-not-pull) changes; its RBAC paragraph was just an incomplete preview of a Role that didn't exist yet when it was written.

## Decision

- **File paths for the application chart's values overlays are `deploy/chart/values-hetzner.yaml` (live) and `deploy/chart/values-eks.yaml` (documented swap, never applied in v1).** This supersedes only the file-path clause in ADR-0001's decision; "one portable Helm chart, no k3s-specific resources, a live overlay plus a documented EKS overlay" stands exactly as ADR-0001 decided it.
- **The top-level `deploy/values-eks.yaml` is a distinct file belonging to the bootstrap layer** (`deploy/bootstrap/`, ADR-0001/0002/0010 per `CLAUDE.md`'s existing row for it) — the ingress-nginx Service-type delta for EKS, unrelated schema, unrelated release. The two `values-eks.yaml` files are not versions of each other and are never merged.
- **RBAC amendment to ADR-0014 (documentation only, not a behavior change):** the `deployer` Role's full surface, as shipped in `deploy/bootstrap/rbac/role.yaml`, is:
  - `apps/deployments` — full CRUD (the workload Helm manages).
  - `apps/replicasets` — `get`/`list`/`watch` only. `helm upgrade --install --wait` polls Deployment rollout status via its ReplicaSet, not the Deployment object alone; omitting this makes `--wait` fail with `Forbidden`.
  - `""/services`, `""/configmaps`, `""/serviceaccounts` — full CRUD (chart-managed objects).
  - `""/secrets` — full CRUD. Covers both application secrets (e.g. the sealed-secrets controller's decrypted output) and Helm's own release-state storage (`Secret`s of type `helm.sh/release.v1`).
  - `""/pods` — `get`/`list`/`watch` only. `--wait` polls Pod readiness; Helm never creates Pods directly (the Deployment controller does).
  - `networking.k8s.io/ingresses`, `networking.k8s.io/networkpolicies` — full CRUD (the chart's Ingress and default-deny NetworkPolicy).
  - `bitnami.com/sealedsecrets` — full CRUD (the chart's `templates/sealed-secrets.yaml`, which applies files under `deploy/chart/sealed/`).
  - Cluster-scoped: a separate `ClusterRole` (`namespace-reader`) grants `get` on `namespaces`, `resourceNames: ["frontdesk"]` only — `helm upgrade --install -n frontdesk` (no `--create-namespace`) checks the namespace exists first, which is a cluster-scoped read even though everything else `deployer` touches is namespaced.

  This is the complete Role; nothing here grants access ADR-0014's "no cluster-admin, no cross-namespace" principle didn't already promise.

## Consequences

- `CLAUDE.md`'s ADR map gets a row for `deploy/chart/` pointing at this ADR alongside 0001/0002/0010/0014, since the file-path clause it depends on now lives here.
- No file moves: `deploy/chart/values-hetzner.yaml` and `deploy/chart/values-eks.yaml` are already where #18 put them; this ADR documents the existing state rather than changing it.
- Future agents reading ADR-0001 for "where do the values overlays live" should follow this ADR's file-path clause instead of ADR-0001's literal text; ADR-0001's own text is left as written, per the rule that a decided ADR's decision is never edited.
- Future agents reading ADR-0014 for "what can the deployer Role do" should read this ADR's RBAC section for the exhaustive list; ADR-0014's prose stays as the design rationale (why a scoped SA at all), not the verb-by-verb reference.
- If the chart grows a resource kind Helm needs to manage (e.g. a `CronJob` or a `HorizontalPodAutoscaler`), the Role and this ADR's list are updated together in the same PR; a chart change that needs a new verb without a matching RBAC and ADR update is incomplete.

## Rejected

- **Editing ADR-0001's or ADR-0014's decision text directly.** `docs/adr/README.md`: "never edit a decided ADR's decision." Both ADRs' core decisions are correct and unchanged; only a file path (0001) and a level of enumeration detail (0014) needed catching up.
- **Renaming the bootstrap layer's `deploy/values-eks.yaml` to remove the collision-in-name-only.** It already has its own `CLAUDE.md` row and `docs/conventions.md` layout entry distinguishing it from `deploy/chart/values-eks.yaml`; renaming a file that isn't actually broken just to avoid a documentation ambiguity is churn for no operational benefit.
- **Moving `deploy/chart/values-hetzner.yaml`/`values-eks.yaml` back to the top level to match ADR-0001's literal text.** Would recreate the exact collision with the bootstrap layer's `deploy/values-eks.yaml` that motivated putting them inside the chart directory in the first place.
