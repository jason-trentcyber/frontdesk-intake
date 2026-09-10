# ADR-0019: The `frontdesk-db-migrate` Job runs `post-install,pre-upgrade`, not `pre-install,pre-upgrade`; amends ADR-0018

Status: decided 2026-09-10. Supersedes the hook-phase clause `pre-install,pre-upgrade` in ADR-0018's Migrations section. Everything else in ADR-0018 stands: the Job's name, `backoffLimit: 0`, the delete policy, the dedicated `ghcr.io/jason-trentcyber/frontdesk-db` image built and digest-pinned by `deploy.yml`, the ADR-0017 credential split (this Job is the only pod referencing `frontdesk-password`), the labels that match no Service selector, and migrations-then-seed as the Job's command.

## Context

ADR-0018 was written before the Job template existed. Its hook phase does not survive a check against Helm's ordering, and #21 PR C is the PR that would have encoded it.

- **Helm's install order is: `pre-install` hooks → render and apply the release's resources → (with `--wait`) wait for them to be Ready → `post-install` hooks.** On a *fresh* install of the `frontdesk` release, a `pre-install` migrate Job therefore starts when the Postgres `StatefulSet`, its Services and its PVC **do not exist yet and cannot be created until the hook finishes**. `db/src/migrate.ts` retries the connection 30 × 2 s and then throws; `backoffLimit: 0` turns that into a failed hook, which fails the install before Postgres is ever applied. It is a deadlock, not a race — no timeout value fixes it.
- **This is latent, not currently broken.** The `frontdesk` release already exists on the cluster, so only `pre-upgrade` fires on every deploy from `main`, and Postgres is up by then. The path it breaks is the one the backup/restore work exists for: rebuilding the release from nothing (ADR-0016's restore drill, a new namespace, or the ADR-0001 EKS deployment).
- Same failure class as ADR-0016's "the chart renders two `DATABASE_URL` Secrets from the sealed secret" (superseded by ADR-0017) and its `postgresql.conf` include clause (#73): a Decision bullet naming a mechanism whose inputs do not exist at the layer it runs at. The test that catches it — *template time / admission / controller / pod runtime, does the input exist at that layer?* — is now in `docs/conventions.md`.

## Decision

- The hook annotation is **`helm.sh/hook: post-install,pre-upgrade`**. Every other annotation from ADR-0018 is unchanged: `helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded` (a failed hook pod is kept for `kubectl logs`), `helm.sh/hook-weight: "0"`.
- On **install**: Helm applies the chart, `--wait` blocks until the Postgres pod is Ready, then the migrate Job runs and the release succeeds only if it does. `db/src/migrate.ts`'s connection retry stays — it covers the ordinary upgrade case where Postgres is restarting, not the absence of the StatefulSet.
- On **upgrade**: unchanged from ADR-0018 — `pre-upgrade`, so a failing migration fails the release before `web` rolls.
- The Job is gated on `db.migrate.enabled` (default `true`) so `values-eks.yaml`, which sets `postgres.enabled: false`, can point it at an external database or turn it off without a template change.

## Consequences

- On a fresh install the `web` Deployment becomes Ready before the schema exists. Today that is harmless (`web` does not touch the database until #26). Once it does, a fresh install starts `web` against an empty database for the length of the migration; the pods error and recover on their own, and the release still fails if the migration fails. Accepted rather than adding a second ordering mechanism for a path that runs once per cluster lifetime.
- `helm rollback` does not undo a migration. Migrations are forward-only (`docs/conventions.md`); recovery from a bad migration is a restore from the ADR-0016 dump, which is exactly what the drill in `deploy/postgres/restore-drill.sh` rehearses.
- ADR-0018's acceptance criterion 5 ("`helm upgrade` from `main` runs `frontdesk-db-migrate`") is unchanged and still the live check. One is added: on a fresh install into a scratch namespace, the Job runs *after* Postgres is Ready and the release succeeds.

## Rejected

- **Keep `pre-install` and raise the retry window in `migrate.ts`.** Structurally impossible: the resources it waits for are not applied until the hook completes.
- **Make the Postgres StatefulSet, Services and PVC `pre-install` hooks too, ordered by `hook-weight` ahead of the migrate Job.** Would restore a single phase, but hook-managed resources sit outside the release's normal lifecycle — `helm.sh/resource-policy: keep` on the backups PVC and the StatefulSet's own upgrade behaviour would both have to be re-reasoned, to buy ordering that `post-install` already gives for free.
- **Drop the hook entirely and run migrations from an init container on `web`.** Replicas race, the app role cannot run DDL (ADR-0016), and it would put `frontdesk-password` in the `web` pod — ADR-0017's split exists to prevent exactly that.
- **`post-install,post-upgrade`.** Symmetric and tempting, but it inverts the guardrail on the path that actually runs every deploy: `web` would roll onto a schema that has not been migrated yet, and a failed migration would be reported after the new code is already serving.
