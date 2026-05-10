#!/usr/bin/env bash
# One-shot first-deploy script for Reflect on the shared Contabo VPS.
#
# Reflect is fully self-contained — its own Caddy ingress on host :443
# with its own Let's Encrypt cert (DNS-01 via Cloudflare). No reliance
# on bober/swiftmail nginx, no shared Docker network with them.
#
#   git clone https://github.com/<owner>/reflect.git /opt/reflect
#   cd /opt/reflect
#   cp deploy/.env.prod.example .env
#   nano .env                  # fill in secrets including CLOUDFLARE_API_TOKEN
#   bash deploy/setup-reflect.sh

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "ERROR: /opt/reflect/.env not found. Copy deploy/.env.prod.example -> .env and fill in secrets first."
  exit 1
fi

# Caddy needs a DNS-01 challenge against Cloudflare. Bail early with a
# clear message if the token isn't set.
if ! grep -qE '^CLOUDFLARE_API_TOKEN=.+$' .env; then
  echo "ERROR: CLOUDFLARE_API_TOKEN missing from .env. Caddy won't be able to issue a Let's Encrypt cert without it."
  exit 1
fi

echo "==> Building images (api + web + caddy)..."
docker compose -f docker-compose.prod.yml build --parallel

echo "==> Starting containers..."
docker compose -f docker-compose.prod.yml up -d

echo "==> Waiting for API to come up..."
for i in $(seq 1 30); do
  if docker compose -f docker-compose.prod.yml exec -T api node -e "require('http').get('http://localhost:3000/api', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))" >/dev/null 2>&1; then
    echo "    API is up."
    break
  fi
  sleep 2
done

echo "==> Waiting for Caddy to issue a TLS cert..."
for i in $(seq 1 60); do
  if docker logs reflect_caddy 2>&1 | grep -q "certificate obtained successfully"; then
    echo "    Cert issued."
    break
  fi
  sleep 2
done

echo ""
echo "==> Done. Reflect should now serve at https://reflect.swift-mail.app"
echo ""
echo "Pre-flight check (do these once):"
echo "  1. Cloudflare DNS: A record  reflect  ->  $(curl -sf ifconfig.me 2>/dev/null || echo '<server-ip>')"
echo "     IMPORTANT: set Proxy status to DNS-only (gray cloud) so browser hits Caddy directly."
echo "  2. Google OAuth (if used): add  https://reflect.swift-mail.app/api/auth/google/callback"
echo "     to Authorized redirect URIs in https://console.cloud.google.com/apis/credentials"
echo "  3. Tail logs:    docker compose -f docker-compose.prod.yml logs -f"
