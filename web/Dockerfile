# Build context is the repo root (pnpm workspace), not web/:
#   docker build -f web/Dockerfile .
# Next's `output: standalone` traces workspace deps, so the deps/build
# stages need the whole workspace (pnpm-workspace.yaml, root package.json,
# every member's package.json) even though only @frontdesk/web is built.

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS base
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/package.json
COPY api/package.json api/package.json
RUN pnpm install --frozen-lockfile --filter @frontdesk/web...

FROM base AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/web/node_modules ./web/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web ./web
ENV NEXT_TELEMETRY_DISABLED=1
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

USER nextjs
EXPOSE 3000

CMD ["node", "web/server.js"]
