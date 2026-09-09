# ADR-0016: Postgres on the cluster as a StatefulSet in the app chart; one image (pgvector + pgmq) for local and prod; nightly `pg_dump` to a PVC, pulled off-node to the VPS

Status: decided 2026-09-09. Implements #20. Amends the RBAC list of ADR-0015 (adds the resource kinds Helm needs to manage a database) and narrows nothing in ADR-0001/0004/0005/0007/0010/0012/0014; issue #20's body named CloudNativePG and Hetzner Object Storage as candidates, and this ADR rejects both, with reasons.

## Context

The application (#21–#29) needs a Postgres 16 with `pgvector` (ADR-0005) and `pgmq` (ADR-0004). Facts checked on 2026-09-09:

- **The node.** One `cx23` (2 vCPU / 4 GB / 40 GB, ADR-0010). Live usage after #18: 1.49 GiB of 3.8 GiB used, 32 GB disk free. The only StorageClass is `local-path` (`rancher.io/local-path`, reclaim `Delete`, `WaitForFirstConsumer`), which is a directory under `/var/lib/rancher/k3s/storage/` on the node — no CSI driver, no VolumeSnapshots. Database durability is therefore exactly node-disk durability unless something copies data off the node.
- **Backup targets that already exist.** The Hermes VPS (`trentcyber-main`, 123 GB free) is on the same tailnet as the node (ADR-0013) and already hosts the off-node half of this system (observability, ADR-0010; Terraform state copy, ADR-0012). The MacBook holds the manual off-provider copies. There is no object storage; ADR-0012 rejected a Hetzner bucket (~€5/mo) for a single-operator project and set a concrete trigger for revisiting.
- **Images.** No published Postgres 16 image ships both extensions. Since pgmq 1.0 the extension is pure SQL/PL-pgSQL: `pgmq-extension/` has a PGXS `Makefile` with only `DATA = sql/*.sql`, no `MODULES`, no Rust (checked at `v1.13.0`). Installing it is copying `pgmq.control` and `pgmq--1.13.0.sql` into `$sharedir/extension/`. `pgvector/pgvector:0.8.6-pg16-bookworm` is an official, multi-arch, PGDG-based image. `deploy/local/postgres.Dockerfile` today does the reverse (pgmq base, compile pgvector) and is used only by `compose.yaml`.
- **Bitnami is gone as an option.** Broadcom moved versioned Bitnami images to `bitnamilegacy` (Aug–Sep 2025) with no further updates; the `bitnami/postgresql` chart that #20's body mentions no longer has maintained images behind it.
- **CloudNativePG's value is mostly elsewhere.** Its backup model is Barman to object storage (plugin) or CSI VolumeSnapshots; this cluster has neither. Its HA model is primary + hot standbys; this cluster has one node. What remains — declarative roles, `kubectl cnpg status`, managed upgrades — costs an operator Deployment (~150–250 MiB) plus CRDs on a 4 GB node where the application has ~2.3 GiB left.
- **Tenancy needs two roles.** ADR-0007's RLS layer only works for a role without `BYPASSRLS`; a superuser bypasses RLS silently. So the runtime role and the migration/owner role must be different from day one, and both must exist at `initdb` time, before Prisma (#21) runs.
- **Deploy mechanics.** `deploy.yml` builds the app image per merge and pins it by digest (ADR-0014). If the database image were rebuilt and re-pinned the same way, every web deploy would roll the Postgres pod. The database image changes a few times a year, by a deliberate bump.

## Decision

### Shape

- **Postgres runs as a `StatefulSet` (1 replica) inside `deploy/chart/`, gated by `postgres.enabled` (default `true`, `false` in `values-eks.yaml`).** One chart, one release, as ADR-0001 decided; the EKS swap is `postgres.enabled: false` plus an externally supplied `DATABASE_URL` secret (RDS), which is the same values-file discipline every other platform difference already uses. `helm upgrade` on an unchanged StatefulSet is a no-op, so app deploys do not touch the database.
- **No operator.** See Rejected.
- **Storage:** `volumeClaimTemplates` → PVC `data` (10 Gi) on the default StorageClass; a second PVC `frontdesk-db-backups` (5 Gi) for dumps, annotated `helm.sh/resource-policy: keep`. `local-path` does not enforce the sizes; they document intent and are real on `gp3`. Both are `ReadWriteOnce`; the backup CronJob and the database share a node by construction here and by a `podAffinity` rule on EKS if `postgres.enabled` is ever true there.
- **Sizing (ADR-0010 budget):** requests `100m` / `256Mi`, limits `1000m` / `1Gi`; `shared_buffers=192MB`, `effective_cache_size=512MB`, `work_mem=8MB`, `maintenance_work_mem=64MB`, `max_connections=60`. Total chart requests after this: ~0.4 GiB of the 2.8 GiB ceiling. Config is a ConfigMap mounted as `postgresql.conf` include, not `ALTER SYSTEM`, so it is reviewable in the PR.
- **Security context:** `runAsUser/runAsGroup/fsGroup: 999` (the numeric UID the official image and pgvector image use — same lesson as #18: named `USER` values fail `runAsNonRoot`), `readOnlyRootFilesystem: false` (Postgres writes to `/var/run/postgresql`; an `emptyDir` covers it, and the ADR notes the exception), capabilities dropped, seccomp `RuntimeDefault`.
- **NetworkPolicy:** ingress to 5432 only from pods in the `frontdesk` namespace carrying `app.kubernetes.io/part-of: frontdesk` (web, api, worker, the backup job). No ingress from other namespaces. Egress: none needed.

### Image

- **One image, `ghcr.io/jason-trentcyber/frontdesk-postgres`, built from `deploy/postgres/Dockerfile`, used by both `compose.yaml` and the chart.** Local dev and production run byte-identical database images; `deploy/local/postgres.Dockerfile` moves to `deploy/postgres/Dockerfile` and `compose.yaml`'s `build:` follows it.
- **Base is `pgvector/pgvector:<ver>-pg16-bookworm`; pgmq is added by copying its control and SQL files** (`COPY --from=ghcr.io/pgmq/pg16-pgmq:v1.13.0 /usr/share/postgresql/16/extension/pgmq* …`, or the equivalent from the release tarball; pgmq's own image also carries a compiled `pg_partman`, which is optional and not copied — partitioned queues are not used). No compiler in the image, no build stage, no `apt` at all. This inverts today's local Dockerfile because pgvector is the compiled one and pgmq is the SQL one — the cheap direction is to start from the compiled artifact.
- **Version tag = content:** `16.<minor>-pgvector<ver>-pgmq<ver>` (e.g. `16.15-pgvector0.8.6-pgmq1.13.0`). A workflow `postgres-image.yml` runs on PRs and pushes to `main` that touch `deploy/postgres/**`: it builds, **refuses to overwrite an existing tag** (`docker buildx imagetools inspect` succeeding = fail the job), pushes, and prints the digest in the job summary. The PR that bumps the image also commits that digest into `values.yaml` (`postgres.image.digest`), and a CI step verifies the committed digest matches the tag on GHCR. So ADR-0014's "images by digest" holds for the database too, the pin changes only in an image-bump PR, and `deploy.yml` never rebuilds or re-pins it.
- Dependabot `docker` ecosystem is enabled for `deploy/postgres/` so base-image bumps arrive as PRs (they still go through the flow above).

### Roles and secrets

- `initdb` scripts in the image (`/docker-entrypoint-initdb.d/`, shared by compose and the cluster) create: extensions `vector` and `pgmq`; role `frontdesk` (database owner, runs Prisma migrations, `NOSUPERUSER NOBYPASSRLS`); role `frontdesk_app` (runtime, `NOSUPERUSER NOBYPASSRLS NOCREATEDB`, `GRANT USAGE` on schemas, DML on tables via default privileges set by the owner). The `postgres` superuser is used by the container entrypoint and the backup job only.
- Three passwords, one SealedSecret `postgres-credentials` (keys `postgres-password`, `frontdesk-password`, `frontdesk-app-password`) sealed by Jason for namespace `frontdesk` per `deploy/chart/sealed/README.md`. The chart renders two `DATABASE_URL`-style secrets from it for consumers: `database-migrate` (owner) and `database-app` (runtime). Web/api/worker mount only `database-app`; the migration Job (#21) mounts `database-migrate`. Locally, compose gets the same three names from `.env`.

### Backups

- **In-cluster `CronJob` `frontdesk-db-backup`, 03:15 UTC nightly**, same image, runs `pg_dumpall --globals-only` and `pg_dump -Fc frontdesk` into the backups PVC as `frontdesk-<UTC timestamp>.dump` + `.globals.sql`, then prunes files older than **14 days**. `successfulJobsHistoryLimit: 3`, `failedJobsHistoryLimit: 3`; kube-state-metrics (already scraped, ADR-0010) exposes `kube_job_failed`, so a failed backup is an alert for #52/#32, not a surprise at restore time. Queue tables created by `pgmq.create()` are ordinary tables and `pgmq.meta` is marked `pg_extension_config_dump`, so the dump contains the queues; the restore needs only the same image.
- **Off-node copy: the VPS pulls nightly.** A cron entry on `trentcyber-main` (Jason's crontab, 04:00 UTC) runs `rsync` over the tailnet from the node's local-path directory (`/var/lib/rancher/k3s/storage/*_frontdesk_frontdesk-db-backups/`) to `~/backups/frontdesk-db/` using the existing `~/.ssh/frontdesk-node` key, keeping 14 days there too. Same pattern as the Terraform state copy (ADR-0012): existing hosts, existing credentials, zero new cost. Read-only on the node side (`rsync` pulls; nothing on the node can reach the VPS).
- **Off-provider copy is manual**, like the state file: the `infra/hetzner/README.md` `scp` block gains one more line for the newest dump. Both the node and the VPS are Hetzner; this ADR does not pretend otherwise (see Consequences).
- **Restore is a documented runbook and is exercised once at acceptance:** `deploy/postgres/README.md` describes restoring the newest dump into a scratch database (`frontdesk_restore_test`) on the same instance with `pg_restore --create --no-owner …`, verifying `\dx` shows both extensions and a row count matches, then dropping it. The drill result (date, dump name, rows) is recorded in the README the first time and in #20's closing comment.

### RBAC (amends ADR-0015's list; `deploy/bootstrap/rbac/role.yaml` changes in the same PR)

- `apps/statefulsets` — full CRUD.
- `""/persistentvolumeclaims` — `get`/`list`/`watch`/`create`/`patch`/`update`. **No `delete`.** CI can create the volumes and adjust labels; only a human with the admin kubeconfig can delete a PVC.
- `batch/cronjobs` — full CRUD (the backup schedule is chart-managed).
- `batch/jobs` — `get`/`list`/`watch`/`create`/`delete` (the Prisma migration Job from #21 is a Helm hook the release must create and clean up).
- No `pods/exec`, no `pods/log`. Restore drills and ad-hoc `psql` are human actions over the tailnet.

### Acceptance (replaces #20's bucket-based criteria)

1. `kubectl -n frontdesk exec sts/frontdesk-postgres -- psql -U frontdesk -c '\dx'` lists `vector 0.8.6` and `pgmq 1.13.0`.
2. `SELECT rolbypassrls FROM pg_roles WHERE rolname IN ('frontdesk','frontdesk_app')` is `false` for both.
3. `kubectl -n frontdesk create job --from=cronjob/frontdesk-db-backup drill-1` completes; a `.dump` and `.globals.sql` appear in the backups PVC.
4. The same files appear under `~/backups/frontdesk-db/` on the VPS after the pull.
5. The restore runbook has been run once against a real dump and the result is recorded.
6. `helm upgrade` of an app-only change leaves the Postgres pod's `RESTARTS` and start time unchanged.
7. `make up` locally uses the same Dockerfile; `\dx` shows the same two versions.

## Consequences

- **Durability is bounded and stated:** at most 24 h of data loss (nightly dumps, no WAL archiving); node loss is covered by the VPS copy; Hetzner-account loss is covered only by the manual MacBook copy. Every row in the database today is fictional or purged within 24 h (ADR-0007, N7), so this is proportionate. The trigger for a superseding ADR is concrete: a paying org's data in the database, or a second node. Either one reopens PITR (needs an archive target) and, with it, object storage or CNPG.
- **No HA and a restart on every image bump** (a few minutes, a few times a year). Stated in the README next to "one node, no HA".
- **Two mechanisms make the backup, not one**: the CronJob (platform-native, alertable, portable) and the VPS pull (off-node, tailnet-only). Each is independently checkable with one command; a single-mechanism design would have had to pick between "in-cluster but on the same disk" and "off-node but invisible to the cluster".
- `docs/conventions.md`'s layout gains `deploy/postgres/` (Dockerfile, initdb, runbook); `CLAUDE.md`'s ADR map gains this ADR on `deploy/chart/`, `deploy/postgres/`, and `deploy/bootstrap/rbac/`; the Makefile/README lines that say `deploy/local` move with the file.
- `values-eks.yaml` documents the RDS swap: `postgres.enabled: false`, `database.externalSecretName`, and that pgvector and pgmq must be enabled on the RDS side (`rds.extensions`, both are supported on RDS for PostgreSQL 16 — pgmq via its SQL-only install path, since RDS does not ship the extension).
- Total chart requests stay under the ADR-0010 ceiling; the numbers are in `values.yaml` with this ADR cited.

## Rejected

- **CloudNativePG.** The right operator for this database when it has a second node or an object-storage target; today it would bring CRDs and a ~200 MiB operator to run a single instance whose backups it cannot take (no Barman target, no CSI snapshots). Leading candidate for the superseding ADR named above — the StatefulSet-to-CNPG migration is a `pg_dump`/restore, i.e. this ADR's own runbook.
- **Bitnami `postgresql` chart** (named in #20). Images unmaintained since the Broadcom change; would also need a custom image anyway.
- **Zalando / Percona / StackGres operators.** Same objection as CNPG with more moving parts.
- **Hetzner Object Storage as the backup target** (named in #20). ADR-0012 already rejected a bucket for this project at this stage, with a written trigger; taking one for dumps but not for state would be inconsistent, and it is a new line item (~€5/mo) for data that is fictional by requirement.
- **Cloudflare R2 (free tier, existing vendor).** Genuinely attractive — 10 GB free, no egress charges, and off-provider — but it needs billing enabled on the account and a new credential pair in the cluster, and the project has a stated preference for fewer credentials over more (ADR-0012 §Rejected). Recorded as the preferred *off-provider* target if the superseding ADR wants one that isn't a laptop.
- **Managed Postgres (Neon, Supabase, Hetzner's managed DB when it exists).** Breaks "one datastore, one backup, transactional consistency" (ADR-0005) and the portable-chart story; the EKS analog is RDS via `postgres.enabled: false`, which the chart supports.
- **WAL archiving / PITR now.** Needs an archive target, which is the bucket question again. Nightly dumps are proportionate to data that is purged nightly.
- **Backup by `kubectl exec pg_dump` from the VPS only** (no CronJob). One moving part, but invisible to the cluster (no `kube_job_failed`), dependent on the VPS being up, and not something the chart carries to another platform. Kept as the *manual* form of the same command in the runbook.
- **Postgres as a second Helm release / chart.** Would avoid CI touching the database at all, at the cost of a second release, a second values split, and a second place ADR-0001's "one chart" story has to explain away. `postgres.enabled` and the no-`delete`-on-PVC RBAC give the same protection inside one release.
- **Keeping today's Dockerfile direction (pgmq base, compile pgvector).** Works, but compiles a C extension in every build for no reason now that pgmq is SQL-only; and the pgmq image is not the PGDG-tracking one. Inverting it removes the toolchain from the image entirely.
- **Alpine base.** musl/ICU/locale differences are exactly the kind of thing that breaks `pg_restore` between environments; bookworm everywhere.
- **Rebuilding and re-pinning the database image in `deploy.yml` like the app image.** Would restart Postgres on every merge to `main`.
