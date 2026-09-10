# Build context is the repo root (pnpm workspace), not db/, same as
# web/Dockerfile:
#   docker build -f db/Dockerfile .
# Unlike web's Next standalone output, migrate.js/seed.js have no bundler
# step - they run tsc-compiled JS directly against node_modules, so the
# runner stage needs real, production-only node_modules alongside
# db/dist, not a traced subset. Hence the extra prod-deps stage below.

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS base
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY db/package.json db/package.json
COPY web/package.json web/package.json
COPY api/package.json api/package.json
RUN pnpm install --frozen-lockfile --filter @frontdesk/db...

FROM deps AS prod-deps
WORKDIR /repo
# CI=true: pnpm otherwise refuses to prune the existing (dev-inclusive)
# node_modules non-interactively ("no TTY") when re-installing --prod.
RUN CI=true pnpm install --frozen-lockfile --filter @frontdesk/db... --prod

FROM base AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/db/node_modules ./db/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY db ./db
RUN pnpm --filter @frontdesk/db build

FROM base AS runner
WORKDIR /app/db
ENV NODE_ENV=production

COPY --from=prod-deps --chown=1000:1000 /repo/node_modules /app/node_modules
COPY --from=prod-deps --chown=1000:1000 /repo/db/node_modules ./node_modules
COPY --from=builder --chown=1000:1000 /repo/db/package.json ./package.json
COPY --from=builder --chown=1000:1000 /repo/db/dist ./dist
COPY --from=builder --chown=1000:1000 /repo/db/drizzle ./drizzle
COPY --from=builder --chown=1000:1000 /repo/db/seed ./seed

# Numeric, not a name: kubelet can't statically resolve a named user
# against runAsNonRoot, and fails the pod with CreateContainerConfigError
# before it ever starts (#18/#65 postmortem; deploy/chart/values.yaml's
# web.podSecurityContext comment). 1000 - db has no analog to web's own
# addgroup/adduser step, so this only needs to be numeric, not any
# specific value; deploy/chart/values.yaml pins the matching runAsUser.
USER 1000:1000

# Migrate then seed - kept as two invocable steps (`node dist/migrate.js`,
# `node dist/seed.js`) since this image is also the future home of the
# ADR-0005 reindex job, not because anything here needs them separate today.
CMD ["sh", "-c", "node dist/migrate.js && node dist/seed.js"]
