# syntax=docker/dockerfile:1
# MediaNexus API — multi-stage build (monorepo context = repo root)
FROM node:22-alpine AS build
WORKDIR /app
# copy manifests first for layer caching
COPY package.json package-lock.json* tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/integrations/package.json packages/integrations/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/compatibility/package.json packages/compatibility/package.json
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
# source
COPY apps apps
COPY packages packages
# build shared packages + api
RUN npm run build:backend

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S mn && adduser -S mn -G mn
COPY --from=build --chown=mn:mn /app/package.json /app/package.json
COPY --from=build --chown=mn:mn /app/apps/api/dist /app/apps/api/dist
COPY --from=build --chown=mn:mn /app/apps/api/package.json /app/apps/api/package.json
COPY --from=build --chown=mn:mn /app/packages /app/packages
COPY --from=build --chown=mn:mn /app/node_modules /app/node_modules
# migrations referenced by the database package
COPY --from=build --chown=mn:mn /app/packages/database/migrations /app/packages/database/migrations
USER mn
EXPOSE 7373
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7373/health/live >/dev/null || exit 1
CMD ["node", "apps/api/dist/main.js"]
