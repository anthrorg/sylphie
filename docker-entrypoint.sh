#!/bin/sh
# Sylphie production entrypoint.
# 1. Applies pending Prisma migrations against the configured DATABASE_URL.
# 2. Launches the NestJS backend.
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] DATABASE_URL is not set; skipping Prisma migrations."
else
  echo "[entrypoint] Applying Prisma migrations..."
  cd /app/packages/shared
  /app/node_modules/.bin/prisma migrate deploy
  cd /app
fi

echo "[entrypoint] Starting Sylphie backend..."
exec node apps/sylphie/dist/main.js
