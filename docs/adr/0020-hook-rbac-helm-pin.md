# ADR-0020: The deployer Role needs `patch` on `batch/jobs` (Helm 4 applies hooks server-side); pin the Helm version in CI; amends ADR-0016

Status: decided 2026-09-10, applied. Supersedes the `batch/jobs` verb list and its "No `patch`" rationale in ADR-0016's RBAC section. Everything else in ADR-0016's RBAC delta stands: `statefulsets` full CRUD, `persistentvolumeclaims` without `delete`, `cronjobs` full CRUD.

## Context

The first deploy after #21 PR C (#80) failed on `main`, at the step the migrate Job exists for:

```
Error: UPGRADE FAILED: pre-upgrade hooks failed: warning: Hook pre-upgrade
frontdesk/templates/db-migrate-job.yaml failed: server-side apply failed for object
frontdesk/frontdesk-db-migrate batch/v1, Kind=Job: jobs.batch "frontdesk-db-migrate"
is forbidden: User "system:serviceaccount:frontdesk:deployer" cannot patch resource
"jobs" in API group "batch" in the namespace "frontdesk"
```

Two independent facts combined to produce it, and both need recording.

**1. Helm 4 applies hook resources with server-side apply.** ADR-0016 granted `batch/jobs` `get`/`list`/`watch`/`create`/`delete` and wrote the exclusion into its decision text: *"No `patch`: the Prisma migration Job (#21) is a Helm hook the release creates and cleans up, not something CI edits in place."* The reasoning was sound for Helm 3, which POSTs hook manifests. Helm 4 sends an apply-patch instead, which the API server authorizes as the `patch` verb regardless of whether the object exists. So a create-only grant cannot install a hook at all under Helm 4 — the exclusion doesn't restrict what CI may edit, it prevents the hook from ever running.

This is the same failure class as ADR-0016's own consumer-secrets clause (→ ADR-0017) and ADR-0018's hook phase (→ ADR-0019): a decision bullet that names a mechanism without checking the layer it executes at. `docs/conventions.md` already carries the test; this one is a new axis — *which client, at which version, performs the write, and what verb does the API server see?* — so the convention gets one more line.

**2. The Helm version in CI is unpinned and floats between runs.** `azure/setup-helm` is SHA-pinned but has no `version:` input, so it installs whatever it resolves as latest. Two deploys 28 minutes apart on the same day used **different** Helm versions:

| Run | Time (UTC) | Helm | Result |
|---|---|---|---|
| `34488172167` | 14:18 | v4.3.0 | success (no hook in the chart yet) |
| `34491065342` | 14:46 | v4.2.4 | failure (first run with the hook) |

A repo that digest-pins every image and SHA-pins every action was letting the tool that talks to the cluster drift, silently and non-monotonically. That is worse than being on the wrong version: it means a deploy failure cannot be reproduced from the commit alone. It did not cause this failure — 4.2.4 and 4.3.0 both apply hooks server-side — but it is why the change in behaviour was invisible until it broke.

## Decision

- **`batch/jobs` gains `patch`** in `deploy/bootstrap/rbac/role.yaml`. Final verb list: `get`, `list`, `watch`, `create`, `patch`, `delete`. No `update`: server-side apply needs `patch` only, and a full-object `update` is the verb that would let CI rewrite a Job it did not render.
- **`update` stays off `batch/jobs`, `delete` stays off `persistentvolumeclaims`.** The principle ADR-0016 was protecting — CI may create and clean up what the chart renders, and may not mutate state outside a release — is unchanged. Only the verb that implements "create" moved.
- **Pin Helm in `deploy.yml`**: `azure/setup-helm` gets `version: v4.3.0`, the version that last deployed successfully. Bumping it is a deliberate PR, like any image or action bump, and the ADR map records that the RBAC surface is a function of the Helm major version.
- **`docs/conventions.md`** gains the client-and-version axis to the existing layer test.

## Consequences

- The `deployer` Role now permits patching any Job in the `frontdesk` namespace. The blast radius is one namespace, and the credential is an ephemeral tailnet-joined runner (ADR-0014); the alternative is no in-cluster migrations at all.
- Applying this is a human step with the admin kubeconfig (`make bootstrap-rbac`), not something the failing deploy can grant itself — as designed. The Role must be applied **before** the next deploy from `main` succeeds.
- Helm upgrades are now a visible PR rather than an invisible drift. In exchange, a Helm release with a genuine fix does not arrive until someone bumps the pin.
- Release revision 11 is `failed`; revision 10 is still `deployed` and serving. Nothing rolled back, because the hook fails before Helm applies anything (ADR-0019's `pre-upgrade` guardrail behaving exactly as intended — `web` never rolled onto an unmigrated schema).

## Rejected

- **Grant `batch/jobs` `*`, or bind the deployer to a broader Role.** Costs the ADR-0014 least-privilege story for one verb.
- **Add `update` alongside `patch` "to be safe".** Nothing needs it; SSA is a PATCH. Speculative grants are how least-privilege dies.
- **Pin Helm to v3.** Would restore the create-only grant, at the cost of running the deploy path on a major version behind the one every other consumer of this cluster uses, to preserve a rule whose rationale no longer holds.
- **Drop the hook and run migrations by hand from the VPS.** Already rejected in ADR-0018; the whole point is that a failing migration fails the release.
- **Leave `setup-helm` unpinned and treat 4.2.4 as an anomaly.** The anomaly is the floating input, not the version it happened to resolve.
