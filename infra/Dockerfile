# =============================================================================
# MORPH - one Dockerfile, four targets
# =============================================================================
# A single file rather than four, because every app shares the same dependency
# install and the same pruned workspace. Four files would drift within a month.
#
# The build is ordered so that the layer that changes on every commit - the source
# code - is the last one. Changing a component re-runs a 15-second build, not a
# four-minute dependency install.
#
# `pnpm deploy --filter` produces a self-contained node_modules for one app, so the
# runtime images do not carry the other three apps' dependencies. On this project
# that is the difference between a 900 MB image and a 180 MB one, which matters
# every time a deploy pulls it.

ARG NODE_VERSION=22.11.0-alpine

# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable
WORKDIR /repo

# -----------------------------------------------------------------------------
# Dependencies. Only the manifests are copied, so this layer is cached until a
# package.json or the lockfile actually changes.
# -----------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/admin/package.json ./apps/admin/
COPY packages/core/package.json ./packages/core/
COPY packages/adaptive/package.json ./packages/adaptive/
COPY packages/crawler/package.json ./packages/crawler/
COPY packages/social/package.json ./packages/social/
COPY packages/telegram/package.json ./packages/telegram/
COPY packages/ui/package.json ./packages/ui/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# Build everything once. Turborepo's cache makes the second and later builds of
# unchanged packages free.
# -----------------------------------------------------------------------------
FROM deps AS build
COPY . .
ENV NODE_ENV=production
RUN pnpm turbo run build

# Prune to one app's runtime closure per target.
RUN pnpm deploy --filter=@morph/web  --prod /out/web  \
 && pnpm deploy --filter=@morph/api  --prod /out/api  \
 && pnpm deploy --filter=@morph/worker --prod /out/worker \
 && pnpm deploy --filter=@morph/admin --prod /out/admin

# -----------------------------------------------------------------------------
# Runtime base. Non-root, minimal, with a signal-forwarding init so a container
# stop actually drains in-flight requests instead of being killed at 10 seconds.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
RUN apk add --no-cache tini \
 && addgroup -S morph && adduser -S morph -G morph
ENV NODE_ENV=production
USER morph
ENTRYPOINT ["/sbin/tini", "--"]

# -----------------------------------------------------------------------------
FROM runtime AS web
WORKDIR /app
COPY --from=build --chown=morph:morph /out/web ./
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# -----------------------------------------------------------------------------
FROM runtime AS api
WORKDIR /app
COPY --from=build --chown=morph:morph /out/api ./
EXPOSE 3001
CMD ["node", "dist/index.js"]

# -----------------------------------------------------------------------------
FROM runtime AS worker
WORKDIR /app
COPY --from=build --chown=morph:morph /out/worker ./
EXPOSE 3003
CMD ["node", "dist/index.js"]

# -----------------------------------------------------------------------------
FROM runtime AS admin
WORKDIR /app
COPY --from=build --chown=morph:morph /out/admin ./
EXPOSE 3002
CMD ["node", "apps/admin/server.js"]
