# syntax=docker/dockerfile:1.7

# ---------- Builder ----------
FROM node:20-alpine AS builder

WORKDIR /app

# Copy lockfiles + workspace manifests so npm can resolve workspaces correctly.
# Prisma schema must be in place BEFORE `npm ci`, because backend's postinstall
# hook runs `prisma generate` and would fail without it.
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY backend/prisma backend/prisma
COPY frontend/package.json frontend/

# Install all dependencies for ALL workspaces. We need backend deps to build,
# and the root install honors the rxjs override pinned in root package.json.
RUN npm ci --workspaces --include-workspace-root --no-audit --no-fund

# Copy the rest of backend source and build.
COPY backend ./backend
RUN cd backend && npm run build

# ---------- Runner ----------
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV API_PORT=3000
ENV PROMPTS_DIR=/app/prompts
# SQLite file lives on a docker volume — survives rebuilds and container
# recreates. /data is created at runtime by the volume mount.
ENV DATABASE_URL=file:/data/reflect.db

# Tini reaps zombies and forwards signals — Node otherwise misses SIGTERM
# from `docker stop`, leaking 10s on every redeploy.
RUN apk add --no-cache tini

# Reuse builder's node_modules verbatim — they already have the generated
# Prisma client (postinstall ran with the schema in place) and bundled
# `prisma` CLI, which the entrypoint needs for `prisma db push` at runtime.
# Trying to reinstall with `--omit=dev` here re-triggers postinstall and
# fails because prisma is a devDependency. Copying the whole tree is
# simpler and the size delta is small for an MVP.
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY backend/prisma ./backend/prisma
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/node_modules ./backend/node_modules

# Compiled JS + runtime assets.
COPY --from=builder /app/backend/dist ./backend/dist
COPY prompts ./prompts

# /data is the SQLite volume mount point. Pre-create it so the first
# `prisma db push` doesn't trip on a missing dir.
RUN mkdir -p /data && chown -R node:node /data /app

USER node
WORKDIR /app/backend

EXPOSE 3000

# `prisma db push` is idempotent — applies any schema diff, no-ops if in
# sync. We use `db push` (not migrate deploy) because the project has no
# migrations folder; the schema is the source of truth.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node dist/main.js"]
