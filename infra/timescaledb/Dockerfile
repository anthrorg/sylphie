# =============================================================
# Sylphie TimescaleDB - Railway Dockerfile
# Wraps timescale/timescaledb:latest-pg17 with extension + events init SQL.
# =============================================================
FROM timescale/timescaledb:latest-pg17

# Enables the timescaledb extension and creates the events hypertable.
COPY init/ /docker-entrypoint-initdb.d/
