# ADR-0017: Consumer credentials via ConfigMap + per-audience `secretKeyRef`; Postgres config as a full `config_file`; amends ADR-0016

Status: decided 2026-09-09. Supersedes two implementation clauses of ADR-0016 ("Roles and secrets" — the two rendered `DATABASE_URL` Secrets; "Sizing" — the `postgresql.conf` include mount). Everything else in ADR-0016 stands, including the two-role model, the single sealed `postgres-credentials` Secret, and the rule that owner credentials are never mounted by web/api/worker.

## Context

ADR-0016 wrote: "The chart renders two `DATABASE_URL`-style secrets from it for consumers: `database-migrate` (owner) and `database-app` (runtime)." Implementing #20 (PR #72) showed that is not possible as written. The three passwords exist only inside the `SealedSecret` ciphertext until the sealed-secrets controller decrypts it *on the cluster*; Helm renders templates before that, on the CI runner, and never sees the plaintext. A chart cannot derive one Secret's contents from another's. The alternatives are an init container or a second controller writing derived Secrets — moving parts whose only job would be string concatenation.

ADR-0016 also wrote: "Config is a ConfigMap mounted as `postgresql.conf` include." The official image's generated `$PGDATA/postgresql.conf` has no `include_dir` hook; making an include work means either editing the generated file at first start (an entrypoint script) or shipping a modified `postgresql.conf.sample` in the image. A full `config_file` override is a single `-c` flag and a mounted file. The generated file contributes nothing the override needs except `listen_addresses`, which the override sets explicitly; `hba_file` and `ident_file` still resolve to `$PGDATA`, so the entrypoint's `scram-sha-256` `pg_hba.conf` remains in force.

The review agent blocked PR #72 on both points (rubric 4) — correctly: the implementation deviated from decided text without a superseding ADR, and the brief that told the agent it could choose was not a substitute for one.

## Decision

- **Connection parameters are a ConfigMap; passwords are `secretKeyRef`s into `postgres-credentials`, one key per audience.** `frontdesk-postgres-connection` carries `PGHOST`, `PGPORT`, `PGDATABASE`, `MIGRATE_PGUSER` (`frontdesk`), `APP_PGUSER` (`frontdesk_app`) — none of it secret. A consumer's pod spec pulls `PGPASSWORD` from exactly one key (`frontdesk-app-password` for web/api/worker; `frontdesk-password` for the #21 migration Job) and builds `DATABASE_URL` with Kubernetes `$(VAR)` expansion in its own `env` block. The kubelet injects only the referenced key; with `automountServiceAccountToken: false` on every app pod, no pod can read the Secret object itself. The two-audience split ADR-0016 wanted is therefore enforced by *which key a Deployment references*, reviewable in the same template that mounts it.
- **Postgres config is a full `postgresql.conf`** (`frontdesk-postgres-config` ConfigMap, mounted at `/etc/postgresql/postgresql.conf`, passed as `-c config_file=`). It lists every non-default setting — `listen_addresses` plus the ADR-0016 sizing values from `values.yaml` — and nothing else, which is *more* reviewable than an include layered on a generated file. `pg_hba.conf` is untouched and stays where the entrypoint writes it.
- The backup CronJob is named `frontdesk-db-backup`, exactly as ADR-0016 wrote it; PR #72's first cut had it as `frontdesk-postgres-backup`, which was a bug against the ADR, fixed rather than superseded.

## Consequences

- No derived Secrets exist in the cluster; there is one secret object for the database, sealed once. Rotating a password = reseal + rollout, same as before.
- Every consumer template must show its `PGPASSWORD` `secretKeyRef` key explicitly. Review rule (add to `docs/conventions.md` when #21 lands the first consumer): web/api/worker Deployments reference `frontdesk-app-password` only; a PR that references `frontdesk-password` or `postgres-password` from an app Deployment is wrong by construction.
- `deploy/postgres/README.md` "Connecting from a consumer" is the reference env block.
- If a future requirement wants per-audience Secret *objects* (e.g. an external secrets operator, or RBAC-visible separation for a human role), the change is three sealed files instead of one and no template redesign.

## Rejected

- **Init container / sidecar that reads `postgres-credentials` and writes `database-migrate` / `database-app` Secrets.** Needs a ServiceAccount with `secrets` write in the namespace on an app pod — exactly the API access every app pod currently lacks — to save a `$(VAR)` line.
- **Sealing three separate Secrets, one per audience, so the chart could reference distinct objects.** Works, and is the fallback named above, but triples the human seal step for no enforcement gain today (no pod can read any Secret object regardless).
- **`include_dir` via a modified `postgresql.conf.sample` baked into the image.** Ties chart config to an image rebuild; the whole point of ADR-0016's tag-is-content rule is that the image changes rarely.
- **Per-setting `-c` flags in `args` instead of a file.** Equivalent, but the settings would live in the StatefulSet spec rather than a mounted file; a ConfigMap diff is easier to read in a PR than an args-array diff.
