#!/usr/bin/env bash
# One-shot first-deploy script for Reflect on the shared Contabo VPS.
#
# Assumes Docker + Compose are already installed (they are — swift-mail
# uses the same box). Run as the `deploy` user from /opt/reflect after cloning.
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/reflect/main/deploy/setup-reflect.sh | bash
#
# or, more typical:
#
#   git clone https://github.com/<owner>/reflect.git /opt/reflect
#   cd /opt/reflect
#   cp deploy/.env.prod.example .env
#   nano .env                  # fill in secrets
#   bash deploy/setup-reflect.sh

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "ERROR: /opt/reflect/.env not found. Copy deploy/.env.prod.example -> .env and fill in secrets first."
  exit 1
fi

echo "==> Building images..."
docker compose -f docker-compose.prod.yml build --parallel

echo "==> Starting containers..."
docker compose -f docker-compose.prod.yml up -d

echo "==> Reconciling bober-web nginx ingress..."
chmod +x deploy/reconcile-reflect-ingress.sh
deploy/reconcile-reflect-ingress.sh

echo "==> Waiting for API to come up..."
for i in $(seq 1 30); do
  if docker compose -f docker-compose.prod.yml exec -T api node -e "require('http').get('http://localhost:3000/api', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))" >/dev/null 2>&1; then
    echo "    API is up."
    break
  fi
  sleep 2
done

echo ""
echo "==> Done. Reflect should now serve at https://reflect.swift-mail.app"
echo ""
echo "Next steps:"
echo "  1. Cloudflare DNS: add A record  reflect  ->  $(curl -sf ifconfig.me 2>/dev/null || echo '<server-ip>')"
echo "     (Proxied — orange cloud — to inherit TLS like app.swift-mail.app)"
echo "  2. Google OAuth (if used): add  https://reflect.swift-mail.app/api/auth/google/callback"
echo "     to Authorized redirect URIs in https://console.cloud.google.com/apis/credentials"
echo "  3. Tail logs:    docker compose -f docker-compose.prod.yml logs -f"
