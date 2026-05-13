#!/bin/bash
# Rotates the sylphie_app runtime user password to the Railway-supplied value.
# Runs last in /docker-entrypoint-initdb.d/ on first DB initialization only.
set -e

if [ -z "$POSTGRES_RUNTIME_PASSWORD" ]; then
  echo "[init] POSTGRES_RUNTIME_PASSWORD not set; keeping default sylphie_app password."
  exit 0
fi

echo "[init] Rotating sylphie_app password from env..."
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  ALTER USER sylphie_app WITH PASSWORD '$POSTGRES_RUNTIME_PASSWORD';
EOSQL
