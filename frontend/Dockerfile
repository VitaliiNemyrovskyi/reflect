# syntax=docker/dockerfile:1.7

# ---------- Builder ----------
FROM node:20-alpine AS builder

WORKDIR /app

# Install ONLY the frontend workspace. `--workspaces` would also run
# backend's postinstall (`prisma generate`) which needs the schema and
# slows the frontend build for nothing. `--include-workspace-root` keeps
# root-level overrides (rxjs pin) intact.
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace=@reflect/frontend --include-workspace-root --no-audit --no-fund

COPY frontend ./frontend
RUN cd frontend && npm run build

# Angular 19 (`application` builder) drops static output at
# dist/<projectName>/browser. Our project is named `reflect` (see
# angular.json), so the path is dist/reflect/browser.

# ---------- Runner ----------
FROM nginx:1.27-alpine AS runner

# nginx config tuned for SPA routing + long-cache for hashed assets.
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/frontend/dist/reflect/browser /usr/share/nginx/html

EXPOSE 80

# nginx default CMD is fine.
