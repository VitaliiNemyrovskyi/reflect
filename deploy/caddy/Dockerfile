# syntax=docker/dockerfile:1.7

# Builds Caddy with the Cloudflare DNS module compiled in, so we can use
# ACME DNS-01 challenge for Let's Encrypt certificates. We need DNS-01
# (not the default HTTP-01 on :80) because port 80 of the host is owned
# by bober's nginx — we don't want to fight for it.

FROM caddy:2-builder AS builder
RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
