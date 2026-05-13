# =============================================================
# Sylphie System Postgres - Railway Dockerfile
# Wraps postgres:17 with the runtime-user + index init scripts.
# =============================================================
FROM postgres:17

# Standard init SQL (creates sylphie_app runtime user, adds indexes).
COPY init/ /docker-entrypoint-initdb.d/

# Railway-specific password override: runs last (zzz prefix) and rotates the
# sylphie_app password to whatever Railway has in POSTGRES_RUNTIME_PASSWORD.
# No-op when the env var is unset so local docker-compose keeps the dev password.
COPY zzz-railway-password.sh /docker-entrypoint-initdb.d/zzz-railway-password.sh
RUN chmod +x /docker-entrypoint-initdb.d/zzz-railway-password.sh
