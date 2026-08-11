# syntax=docker/dockerfile:1
# MediaNexus web — Vite build served by nginx (SPA + /api reverse proxy)
FROM node:22-bookworm-slim AS build
WORKDIR /app
# npm ci installs the whole workspace (incl. native better-sqlite3); provide build tools
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN npm ci --no-audit --no-fund
COPY apps/web apps/web
RUN npm run build -w @medianexus/web

FROM nginx:alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/health/live >/dev/null || exit 1
