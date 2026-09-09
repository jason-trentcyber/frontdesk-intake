# deploy/postgres

Postgres 16 for frontdesk (#20; ADR-0016): the image, roles, backups, and
restore runbook. The chart resources that actually run this image live
in `deploy/chart/` (`postgres-*.yaml` templates); this README documents
the database side, which is identical whether you're running `make up`
locally or the `frontdesk-postgres` StatefulSet in the cluster - both use
the exact same image and `initdb/` scripts.

## What's in the image

`Dockerfile` builds `ghcr.io/jason-trentcyber/frontdesk-postgres`:
`pgvector/pgvector:<ver>-pg16-bookworm` (official, PGDG-based, the
compiled extension) with `pgmq` layered on top by copying its extension
files from `ghcr.io/pgmq/pg16-pgmq` (pure SQL since pgmq 1.0 - nothing to
compile, no toolchain in the image at all). See the Dockerfile's header
comment for the full reasoning and the `ARG`-based version/tag scheme.

`initdb/` is baked into the image at `/docker-entrypoint-initdb.d/`, not
bind-mounted, so the exact same init runs in compose and in the cluster:

- `001-extensions.sql` - `CREATE EXTENSION vector, pgmq`.
- `002-roles.sh` - creates the two roles below and their grants.

## Roles model

Three roles, three different jobs, from `initdb` time (before anything
else ever connects):

| Role | Superuser? | `BYPASSRLS`? | Used by |
|---|---|---|---|
| `postgres` | yes | n/a (superuser bypasses RLS regardless) | the container entrypoint; the nightly backup CronJob |
| `frontdesk` | no | no | owner of the `frontdesk` database; runs Prisma migrations (#21) |
| `frontdesk_app` | no | no | runtime role - what web/api/worker actually connect as |

Both `frontdesk` and `frontdesk_app` are `NOBYPASSRLS` on purpose
(ADR-0007): a superuser or a `BYPASSRLS` role silently skips row-level
security, which would make RLS policies look like they work in every
manual check and then do nothing for the app. `frontdesk_app`'s
privileges come from `frontdesk`'s `ALTER DEFAULT PRIVILEGES` in
`002-roles.sh` for `public`-schema tables (Prisma's), plus direct grants
on `pgmq`'s own pre-existing tables and `CREATE` on the `pgmq` schema
itself (pgmq's functions have no `SECURITY DEFINER`, so `pgmq.create()`
needs the caller to be able to create tables there directly - see that
script's comments for the full reasoning, worked out empirically against
the real image, not assumed).

## Connecting from a consumer

`database-configmap.yaml` renders a ConfigMap
(`frontdesk-postgres-connection`) with `PGHOST`, `PGPORT`, `PGDATABASE`,
and both role names (`MIGRATE_PGUSER` = `frontdesk`, `APP_PGUSER` =
`frontdesk_app`). There's no chart-rendered `DATABASE_URL` secret:
rendering a Secret from another (sealed) Secret isn't possible at Helm
template time - the plaintext in `postgres-credentials` doesn't exist
until the sealed-secrets controller decrypts it on the cluster, after
this chart has already rendered. Instead, a consumer's own `env` block
builds `DATABASE_URL` from parts, using Kubernetes' `$(VAR)` expansion
(resolved pod-side, after the real secret exists):

```yaml
env:
  - name: PGHOST
    valueFrom: { configMapKeyRef: { name: frontdesk-postgres-connection, key: PGHOST } }
  - name: PGPORT
    valueFrom: { configMapKeyRef: { name: frontdesk-postgres-connection, key: PGPORT } }
  - name: PGDATABASE
    valueFrom: { configMapKeyRef: { name: frontdesk-postgres-connection, key: PGDATABASE } }
  - name: PGUSER
    valueFrom: { configMapKeyRef: { name: frontdesk-postgres-connection, key: APP_PGUSER } } # or MIGRATE_PGUSER for the owner role
  - name: PGPASSWORD
    valueFrom: { secretKeyRef: { name: postgres-credentials, key: frontdesk-app-password } } # pair with APP_PGUSER; frontdesk-password pairs with MIGRATE_PGUSER - never cross them
  - name: DATABASE_URL
    value: "postgresql://$(PGUSER):$(PGPASSWORD)@$(PGHOST):$(PGPORT)/$(PGDATABASE)"
```

Keep the ADR's two-audience split: web/api/worker only ever reference
`APP_PGUSER` + `frontdesk-app-password`. Only the Prisma migration Job
(#21) references `MIGRATE_PGUSER` + `frontdesk-password`. Locally,
`.env`/`.env.example` mirror this as two separate variables,
`DATABASE_URL` (owner) and `DATABASE_APP_URL` (runtime).

## Backups

Two independent mechanisms (ADR-0016), not one:

1. **In-cluster `CronJob`** `frontdesk-postgres-backup`, 03:15 UTC nightly:
   `pg_dumpall --globals-only` and `pg_dump -Fc frontdesk`, into the
   `frontdesk-db-backups` PVC (5 Gi, `helm.sh/resource-policy: keep`) as
   `frontdesk-<UTC timestamp>.dump` + `.globals.sql`, then prunes files
   older than 14 days. Connects as the `postgres` superuser (the only
   role used for backups, per the roles table above) - verified end to
   end against the real image: dump, then a real restore into a scratch
   database, with matching row counts.
2. **VPS pull, off-node.** Cron on `trentcyber-main` (Jason's crontab),
   04:00 UTC, pulling over the tailnet (ADR-0013) from the node's
   `local-path` directory to `~/backups/frontdesk-db/`:

   ```cron
   0 4 * * * rsync -az -e "ssh -i ~/.ssh/frontdesk-node" root@100.88.28.10:'/var/lib/rancher/k3s/storage/*_frontdesk_frontdesk-db-backups/' ~/backups/frontdesk-db/ && find ~/backups/frontdesk-db -type f -mtime +14 -delete
   ```

   No `--delete`: the VPS copy is append-only, so a bug or a bad prune on
   the node's own CronJob can't reach back and delete the VPS's copies too
   - the two sides are pruned independently, on purpose. `100.88.28.10` is
   the node's tailnet IP (ADR-0013); the glob matches
   `local-path-provisioner`'s directory naming
   (`<pvc-uid>_frontdesk_frontdesk-db-backups`).
3. **Off-provider copy is manual**, like the Terraform state file
   (ADR-0012): add the newest dump to the `scp` block in
   `infra/hetzner/README.md`.

## Restore runbook

Exercised once at acceptance (ADR-0016 acceptance item 5); the result
goes in the log at the bottom of this file.

```bash
# From the VPS, over the tailnet:
kubectl -n frontdesk cp frontdesk-postgres-0:/dev/null /dev/null  # sanity: pod reachable, then:
DUMP=$(kubectl -n frontdesk exec frontdesk-postgres-0 -- sh -c 'ls -t /backups/*.dump | head -1')
kubectl -n frontdesk cp "frontdesk-postgres-0:${DUMP#/}" ./restore-test.dump

kubectl -n frontdesk exec -it frontdesk-postgres-0 -- bash
# inside the pod:
psql -U postgres -d postgres -c "CREATE DATABASE frontdesk_restore_test;"
pg_restore --no-owner -U postgres --dbname frontdesk_restore_test /backups/<newest>.dump
psql -U postgres -d frontdesk_restore_test -c '\dx'                       # both extensions present
psql -U postgres -d frontdesk_restore_test -c 'SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('\''pg_catalog'\'', '\''information_schema'\'');'
psql -U postgres -d postgres -c "DROP DATABASE frontdesk_restore_test;"
```

**Note on `--create`:** the obvious-looking `pg_restore --create
--no-owner --dbname postgres` does *not* let you rename the target
database via `--dbname` - with `--create`, `--dbname` only picks which
database to connect to in order to issue `CREATE DATABASE`, and the
database that actually gets created is whatever name `pg_dump` recorded
in the archive (`frontdesk`, same as the live one). Verified directly:
using `--create` against a database that already exists just restores
into the live database in place, which is not what a restore drill
should ever do. The two-step version above (`CREATE DATABASE
frontdesk_restore_test` first, then `pg_restore` **without** `--create`,
targeting that name with `--dbname`) is what actually lands in a
separate scratch database.

### Restore drill log

| Date | Dump file | Extensions verified | Row count matched | Notes |
|---|---|---|---|---|
| | | | | |
