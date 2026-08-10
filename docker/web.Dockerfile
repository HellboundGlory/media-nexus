# syntax=docker/dockerfile:1
# MediaNexus web — Vite build served by nginx (SPA + /api reverse proxy)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY apps/web apps/web
COPY docker/nginx.conf docker/nginx.conf
RUN npm run build -w @medianexus/web

FROM nginx:alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/health/live >/dev/null || exit 1
