# Build context is the repo root (pnpm workspace), not web/:
#   docker build -f web/Dockerfile .
# Next's `output: standalone` traces workspace deps, so the deps/build
# stages need the whole workspace (pnpm-workspace.yaml, root package.json,
# every member's package.json) even though only @frontdesk/web is built.
#
# web/ depends on @frontdesk/db (workspace:*, ADR-0021/0027) at runtime -
# `pnpm install --filter @frontdesk/web...` therefore needs db/package.json
# too (the `...` suffix already pulls in workspace dependencies, but only
# once their manifest is present to resolve), and the builder needs db/
# source built into db/dist *before* `next build` runs: output-file-tracing
# follows the pnpm workspace symlink (web/node_modules/@frontdesk/db ->
# ../../db) and traces whatever it finds there right then, dist included or
# not - the same class of ordering issue api/Dockerfile documents for its
# own build step. Verified by actually running the built image (see the PR
# for the full docker run/curl transcript): a build that skips this step
# produces a standalone bundle whose @frontdesk/db has no dist/, and the
# server crashes on the first request with a MODULE_NOT_FOUND for
# @frontdesk/db/dist/index.js.

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS base
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/package.json
COPY api/package.json api/package.json
COPY db/package.json db/package.json
RUN pnpm install --frozen-lockfile --filter @frontdesk/web...

FROM base AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/web/node_modules ./web/node_modules
COPY --from=deps /repo/db/node_modules ./db/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY db ./db
COPY web ./web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @frontdesk/db build
RUN pnpm --filter @frontdesk/web build

# Standalone output is nested at web/.next/standalone/web (workspace
# path preserved) - see web/Dockerfile.README or the comment below.
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /repo/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/web/.next/static ./web/.next/static

# Numeric, not the name "nextjs": kubelet can't statically resolve a named
# user against runAsNonRoot (deploy/chart/values.yaml sets runAsUser: 1001),
# and fails the pod with CreateContainerConfigError before it ever starts.
USER 1001:1001
EXPOSE 3000

CMD ["node", "web/server.js"]
