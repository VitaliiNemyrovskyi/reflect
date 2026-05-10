#!/usr/bin/env bash
# Install reflect.swift-mail.app routing onto the bober-web nginx ingress
# that owns :80 on the shared VPS.
#
# Mirrors deploy/reconcile-swiftmail-ingress.sh from the swift-mail repo.
# Run on every deploy and on host boot — it's idempotent.

set -euo pipefail

INGRESS_CONTAINER="${INGRESS_CONTAINER:-bober-web-1}"
PROXY_NETWORK="${PROXY_NETWORK:-proxy}"
REFLECT_CONF="${REFLECT_CONF:-/opt/reflect/deploy/nginx-reflect.conf}"
TARGET_PATH="${TARGET_PATH:-/etc/nginx/conf.d/reflect.conf}"

log() { echo "[reflect-ingress] $*"; }

if ! docker inspect "$INGRESS_CONTAINER" >/dev/null 2>&1; then
  log "ERROR: ingress container $INGRESS_CONTAINER not found. Nothing to reconcile."
  exit 1
fi

if ! docker network inspect "$PROXY_NETWORK" >/dev/null 2>&1; then
  log "creating missing docker network $PROXY_NETWORK"
  docker network create "$PROXY_NETWORK"
fi

if docker inspect "$INGRESS_CONTAINER" \
     --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
   | grep -qw "$PROXY_NETWORK"; then
  log "$INGRESS_CONTAINER already attached to $PROXY_NETWORK"
else
  log "attaching $INGRESS_CONTAINER to $PROXY_NETWORK"
  docker network connect "$PROXY_NETWORK" "$INGRESS_CONTAINER"
fi

if [ ! -f "$REFLECT_CONF" ]; then
  log "ERROR: source config not found at $REFLECT_CONF"
  exit 1
fi

log "copying $REFLECT_CONF -> $INGRESS_CONTAINER:$TARGET_PATH"
docker cp "$REFLECT_CONF" "$INGRESS_CONTAINER:$TARGET_PATH"

log "validating nginx config"
docker exec "$INGRESS_CONTAINER" nginx -t

log "reloading nginx"
docker exec "$INGRESS_CONTAINER" nginx -s reload

log "done"
