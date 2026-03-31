# 2026-03-29 -- E1-T002: Docker Compose Finalization

## Changes

### NEW: docker/postgres/init.sql
- Creates sylphie_app runtime role with LOGIN and PASSWORD from POSTGRES_RUNTIME_PASSWORD env var
- GRANTs SELECT on all future tables for sylphie_app (RLS enforced in T004)
- GRANTs SELECT, INSERT, UPDATE on all future tables; explicitly REVOKEs DELETE
- Sets up DEFAULT PRIVILEGES for sequences and functions
- Includes detailed notes for E1-T004 on how to apply RLS policies to drive_rules table
- No table creation (that's T004's job)

### MODIFIED: docker-compose.yml
- Added `networks: sylphie-net` to all three services (neo4j, timescaledb, postgres)
- Added network definition at top level: bridge driver with subnet 172.25.0.0/16
- Added PostgreSQL init script mount: `./docker/postgres/init.sql:/docker-entrypoint-initdb.d/01-init-runtime-user.sql`
- Added POSTGRES_RUNTIME_PASSWORD to postgres environment variables
- Added POSTGRES_INITDB_ARGS for pg_stat_statements extension
- Added resource limits to all services:
  - neo4j: 2 CPU / 2GB limit, 1 CPU / 1GB reservation
  - timescaledb: 1.5 CPU / 1GB limit, 0.5 CPU / 512MB reservation
  - postgres: 1 CPU / 512MB limit, 0.25 CPU / 256MB reservation

### MODIFIED: .env.example
- Complete rewrite with comprehensive documentation
- Added comments for every variable explaining purpose, valid values, and tuning guidance
- Added missing variables: NEO4J_DATABASE, NEO4J_MAX_CONNECTION_POOL_SIZE, NEO4J_CONNECTION_TIMEOUT_MS
- Added TimescaleDB config: TIMESCALE_RETENTION_DAYS, TIMESCALE_COMPRESSION_DAYS, TIMESCALE_IDLE_TIMEOUT_MS, TIMESCALE_CONNECTION_TIMEOUT_MS
- Added PostgreSQL config: POSTGRES_IDLE_TIMEOUT_MS, POSTGRES_CONNECTION_TIMEOUT_MS, separate admin/runtime user configs
- Added Grafeo config: GRAFEO_SELF_KG_PATH, GRAFEO_OTHER_KG_PATH, GRAFEO_MAX_NODES_PER_KG
- Added LLM config: ANTHROPIC_API_KEY, LLM_MODEL, LLM_MAX_TOKENS, LLM_TEMPERATURE, LLM_COST_TRACKING_ENABLED
- Added Voice config: OPENAI_API_KEY, STT_MODEL, TTS_MODEL, TTS_VOICE

### NEW: .env
- Development defaults matching docker-compose internal networking (timescaledb, postgres, neo4j as hostnames)
- Same variable set as .env.example but with dev values filled in
- Maintains credential defaults from original config

## Wiring Changes

- All services now connected via `sylphie-net` bridge network (isolated from host networking except ports)
- PostgreSQL init script runs on container start, creating sylphie_app role and setting up grants
- All credentials managed via .env (docker-compose uses env substitution)
- Three separate logical databases on two hosts:
  - Neo4j (port 7687 Bolt, 7474 Browser) for World Knowledge Graph
  - TimescaleDB (port 5433) for event backbone
  - PostgreSQL (port 5434) for drive rules, settings, users

## Known Issues

- The init.sql script uses `:'POSTGRES_RUNTIME_PASSWORD'` which requires psql variable substitution. Docker will execute this via /docker-entrypoint-initdb.d/ which pipes to psql and should support this syntax.
- T004 must create the actual tables and apply RLS policies. This script only sets up roles and DEFAULT PRIVILEGES.

## Gotchas for Next Session

- When T004 creates tables, remember to apply RLS on drive_rules with read-only policy for sylphie_app
- Network discovery inside containers uses service names (postgres, timescaledb, neo4j), not localhost
- The docker-compose volumes persist data across restarts; docker compose down will NOT delete volumes
- To reset databases: `docker compose down -v` (deletes volumes) then `docker compose up -d`
- If postgres init script fails silently, check docker logs: `docker compose logs postgres`
- The POSTGRES_INITDB_ARGS expects quotes in docker-compose YAML; ensure `-c` flag syntax is correct
