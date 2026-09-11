# Build context is the repo root (pnpm workspace), not api/, same
# pattern as db/Dockerfile (#80):
#   docker build -f api/Dockerfile .
# api/ depends on @frontdesk/db (workspace:*) at runtime, so the deps and
# builder stages need db/ built too, and the runner needs both packages'
# compiled output + real (non-traced) production node_modules - no
# bundler step, same reasoning as db/Dockerfile. pnpm's workspace
# symlinks are relative (api/node_modules/@frontdesk/db -> ../../../db),
# so the runner's directory layout below (api/ and db/ as siblings under
# /app, root node_modules at /app/node_modules) has to mirror the repo's
# own layout for them to resolve - verified by actually running the
# built image.

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS base
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json api/package.json
COPY db/package.json db/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --filter @frontdesk/api...

FROM deps AS prod-deps
WORKDIR /repo
# CI=true: pnpm otherwise refuses to prune the existing (dev-inclusive)
# node_modules non-interactively ("no TTY") when re-installing --prod.
RUN CI=true pnpm install --frozen-lockfile --filter @frontdesk/api... --prod

FROM base AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/api/node_modules ./api/node_modules
COPY --from=deps /repo/db/node_modules ./db/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY db ./db
COPY api ./api
RUN pnpm --filter @frontdesk/db build
RUN pnpm --filter @frontdesk/api build

FROM base AS runner
WORKDIR /app/api
ENV NODE_ENV=production

COPY --from=prod-deps --chown=1001:1001 /repo/node_modules /app/node_modules
COPY --from=prod-deps --chown=1001:1001 /repo/api/node_modules ./node_modules
COPY --from=prod-deps --chown=1001:1001 /repo/db/node_modules /app/db/node_modules
COPY --from=builder --chown=1001:1001 /repo/api/package.json ./package.json
COPY --from=builder --chown=1001:1001 /repo/api/dist ./dist
COPY --from=builder --chown=1001:1001 /repo/db/package.json /app/db/package.json
COPY --from=builder --chown=1001:1001 /repo/db/dist /app/db/dist

# Numeric, not a name: kubelet can't statically resolve a named user
# against runAsNonRoot, and fails the pod with CreateContainerConfigError
# before it ever starts (#18/#65 postmortem). 1001 to match
# deploy/chart/values.yaml's api.podSecurityContext.runAsUser (web also
# uses 1001; db's image uses 1000 - there's no shared UID convention
# across these images, each chart value just has to match its own image).
USER 1001:1001
EXPOSE 3001

CMD ["node", "dist/server.js"]
