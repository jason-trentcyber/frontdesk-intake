# Local dev only. No published image ships both pgvector and pgmq for Postgres 16
# (checked pgvector/pgvector tags and the pgmq project's docker images, 2026-09-07):
# pgvector/pgvector:pg16 has no pgmq, and ghcr.io/pgmq/pg16-pgmq has no pgvector.
# Both projects build against a plain `postgres:16-bookworm` base with the same
# `postgresql-server-dev-16` toolchain, and pgvector is a small C extension (no
# Rust/pgrx toolchain needed, unlike pgmq), so we start from the pgmq image and
# compile pgvector into it rather than the other way around.
FROM ghcr.io/pgmq/pg16-pgmq:v1.13.0

# The base image already switched to USER postgres; apt/make need root.
USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        git \
        postgresql-server-dev-16 \
    && git clone --branch v0.8.6 --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector \
    && cd /tmp/pgvector \
    && make OPTFLAGS="" \
    && make install \
    && cd / \
    && rm -rf /tmp/pgvector \
    && apt-get remove -y build-essential git postgresql-server-dev-16 \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

USER postgres
