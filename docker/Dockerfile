# syntax=docker/dockerfile:1
# MediaNexus — single-container build (build context = repo root).
# The API (NestJS) serves the built web UI directly (apps/web/dist) — one process,
# one port, no nginx/reverse-proxy container. Never expose this port to the public
# internet; there is no login/auth beyond a single system API key.
FROM node:22-bookworm-slim AS build
WORKDIR /app
# build tools for native module compilation (better-sqlite3) under glibc
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# copy manifests first for layer caching
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/integrations/package.json packages/integrations/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/compatibility/package.json packages/compatibility/package.json
RUN npm ci --no-audit --no-fund
# source
COPY apps apps
COPY packages packages
# build shared packages + api + web
RUN npm run build:backend
RUN npm run build -w @medianexus/web

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY --from=build /app/apps/api/package.json /app/apps/api/package.json
COPY --from=build /app/packages /app/packages
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/database/migrations /app/packages/database/migrations
COPY --from=build /app/apps/web/dist /app/web
EXPOSE 7373
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7373/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]
