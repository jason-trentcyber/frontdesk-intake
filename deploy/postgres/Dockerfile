# One Postgres 16 image for local dev (compose.yaml) and production (the
# `postgres` StatefulSet in deploy/chart/, ADR-0016) - byte-identical in
# both places.
#
# Base is the pgvector image (a compiled C extension) with pgmq layered on
# top by copying its extension files - the reverse of the old
# deploy/local/postgres.Dockerfile direction (pgmq base, compile pgvector
# in). pgmq has been pure SQL/PL-pgSQL since 1.0: checked
# ghcr.io/pgmq/pg16-pgmq:v1.13.0 directly - only pgmq.control and
# pgmq--*.sql exist under /usr/share/postgresql/16/extension, nothing
# under /usr/lib/postgresql/16/lib (that image's pg_partman is the only
# .so there, and it is not used or copied - partitioned queues are not
# used). So there is nothing to compile, no toolchain, no `apt`, no build
# stage at all - installing pgmq is copying two kinds of files.
#
# No `USER` change either: this base image's own entrypoint starts as
# root and drops to the `postgres` system user (uid=gid=999, confirmed
# with `docker run --rm --entrypoint sh <img> -c 'id postgres'` - unlike
# web/Dockerfile, #18/#65, there is no Dockerfile-level `USER` here to
# make numeric, the base image relies on its entrypoint's runtime `gosu`
# drop instead) before running Postgres. deploy/chart's securityContext
# pins runAsUser/runAsGroup: 999 explicitly for this same reason.
#
# Version tag = content (ADR-0016): 16.<PG_MINOR>-pgvector<PGVECTOR_VERSION>-pgmq<PGMQ_VERSION>,
# e.g. 16.15-pgvector0.8.6-pgmq1.13.0. PG_MINOR is the Postgres minor
# version actually baked into the pinned pgvector base image (checked with
# `postgres --version` inside it at build-pin time) - it is not
# independently selectable here, only recorded for the output tag.
ARG PG_MINOR=16.15
ARG PGVECTOR_VERSION=0.8.6
ARG PGMQ_VERSION=1.13.0

FROM ghcr.io/pgmq/pg16-pgmq:v${PGMQ_VERSION} AS pgmq

FROM pgvector/pgvector:${PGVECTOR_VERSION}-pg16-bookworm

COPY --from=pgmq /usr/share/postgresql/16/extension/pgmq* /usr/share/postgresql/16/extension/

# Baked into the image, not bind-mounted, so compose and the chart's
# StatefulSet run the exact same init (ADR-0016) - there is no repo
# checkout to mount from in the cluster.
COPY initdb/ /docker-entrypoint-initdb.d/
