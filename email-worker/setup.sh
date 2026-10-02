#!/usr/bin/env bash
# Set up Cloudflare Email Routing -> Worker -> Stalwart (run this after
# `npx wrangler login`). Idempotent: safe to run more than once.
set -euo pipefail
cd "$(dirname "$0")"

WORKER="stalwart-mail-ingest"

if [ -f ../.env ]; then set -a; . ../.env; set +a; fi
: "${ADMIN_PASSWORD:?Missing ADMIN_PASSWORD in ../.env}"
: "${MAIL_DOMAIN:?Missing MAIL_DOMAIN in ../.env}"
DOMAIN="$MAIL_DOMAIN"

echo "== Enabling Email Routing for $DOMAIN (adds MX/TXT automatically) =="
npx wrangler email routing enable "$DOMAIN"

echo "== Deploying worker (STALWART_URL=https://mail.$DOMAIN) =="
npx wrangler deploy --var "STALWART_URL:https://mail.$DOMAIN"

echo "== Setting secret STALWART_ADMIN_PASSWORD (from ../.env) =="
echo -n "$ADMIN_PASSWORD" | npx wrangler secret put STALWART_ADMIN_PASSWORD

echo "== Pointing $DOMAIN's catch-all at worker $WORKER =="
npx wrangler email routing rules update "$DOMAIN" catch-all \
  --action-type worker --action-value "$WORKER" --enabled true

echo "== Done. Verify with: =="
npx wrangler email routing rules list "$DOMAIN"
