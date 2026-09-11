# Build context is the repo root, same as web/db/api (docker build -f
# worker/Dockerfile .) - not because worker/ depends on any other
# workspace package (it's a standalone uv project, no pnpm workspace
# involvement), but because frontdesk_worker/contracts.py resolves the
# committed contract file by a path relative to its own location
# (worker/frontdesk_worker/contracts.py -> ../../docs/contracts/...), so
# the image has to mirror the repo's own worker/ + docs/contracts/ layout
# for that lookup to still work at runtime.
#
# uv, not pip: the project is already uv-managed (worker/pyproject.toml,
# worker/uv.lock) - `uv sync --frozen` gives the same reproducible install
# pnpm --frozen-lockfile gives the other three images. The uv binary itself
# comes from astral's own distroless image (COPY --from), not `pip install
# uv`, so the runner never needs pip either.

FROM python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254 AS base
COPY --from=ghcr.io/astral-sh/uv:0.9.2@sha256:6dbd7c42a9088083fa79e41431a579196a189bcee3ae68ba904ac2bf77765867 /uv /uvx /usr/local/bin/

FROM base AS builder
WORKDIR /app/worker
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
# Dependencies first, from the lockfile alone, so this layer only rebuilds
# when pyproject.toml/uv.lock change - not on every source edit.
COPY worker/pyproject.toml worker/uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev
# Then the project itself.
COPY worker/frontdesk_worker ./frontdesk_worker
COPY worker/llm ./llm
RUN uv sync --frozen --no-dev

FROM base AS runner
WORKDIR /app/worker
ENV PATH="/app/worker/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY --from=builder --chown=1001:1001 /app/worker/.venv ./.venv
COPY --from=builder --chown=1001:1001 /app/worker/frontdesk_worker ./frontdesk_worker
COPY --from=builder --chown=1001:1001 /app/worker/llm ./llm
COPY --chown=1001:1001 docs/contracts /app/docs/contracts

# Numeric, not a name: kubelet can't statically resolve a named user
# against runAsNonRoot, and fails the pod with CreateContainerConfigError
# before it ever starts (#18/#65 postmortem, same reasoning as
# api/Dockerfile). 1001 to match deploy/chart/values.yaml's
# worker.podSecurityContext.runAsUser - no shared UID convention across
# images, each chart value just has to match its own image. python:slim has
# no named USER of its own to fight, unlike db/'s pgvector base image, so
# there's nothing to override here.
USER 1001:1001

CMD ["python", "-m", "frontdesk_worker"]
