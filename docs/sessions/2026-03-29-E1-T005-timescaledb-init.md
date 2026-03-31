# 2026-03-29 -- E1-T005: TimescaleDB connection, hypertable schema, compression and retention

## Changes
- NEW: `src/events/timescale-init.service.ts` -- Complete TimescaleDB schema initialization service with idempotent DDL for events hypertable, compression policies, retention policies, and all required indexes.
- MODIFIED: `src/events/events.tokens.ts` -- Added TIMESCALEDB_POOL Symbol token for pool injection.
- MODIFIED: `src/events/events.module.ts` -- Added TIMESCALEDB_POOL factory provider using pg.Pool with ConfigService, registered TimescaleInitService, and exported both tokens.

## Wiring Changes
- TIMESCALEDB_POOL factory provider reads from ConfigService (appConfig.timescale) for connection parameters, pool size (maxConnections), connection timeout, and idle timeout.
- TimescaleInitService injects TIMESCALEDB_POOL and ConfigService; runs on OnModuleInit to create hypertable schema; runs on OnModuleDestroy to gracefully close pool.
- EventsModule now exports TIMESCALEDB_POOL alongside EVENTS_SERVICE for potential use by other modules.

## Known Issues
- EventsService methods still throw "Not implemented" stubs (expected -- schema is ready for real implementation in Epic 2).
- Compression policy requires ALTER TABLE SET to enable compression before adding policy; handled with DO block exception handling.

## Gotchas for Next Session
- All DDL is idempotent (IF NOT EXISTS, if_not_exists => TRUE) and safe to run on app restart.
- Config values for compressionDays and retentionDays are read from AppConfig at init time; changes require app restart.
- Pool cleanup is essential: TimescaleInitService.onModuleDestroy() calls pool.end() to prevent connection leaks.
- Health check validates both basic connectivity and hypertable existence via timescaledb_information.hypertables system view.
