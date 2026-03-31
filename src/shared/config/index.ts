/**
 * Barrel export for the shared config directory.
 *
 * Consumers import configuration types and factories from this barrel rather
 * than from internal file paths. Internal file structure is an implementation
 * detail.
 *
 * Note on naming: app.config.ts is the authoritative source for the per-section
 * interface types (Neo4jConfig, TimescaleConfig, etc.) because it owns the
 * registerAs() factory. database.config.ts re-declares those same shapes and
 * adds the DatabaseConfig aggregate. To avoid duplicate exports, only the
 * aggregate DatabaseConfig is re-exported from database.config.ts here.
 */

export {
  appConfig,
  type AppConfig,
  type AppSectionConfig,
  type Neo4jConfig,
  type TimescaleConfig,
  type PostgresConfig,
  type GrafeoConfig,
  type LlmConfig,
} from './app.config';

export { type DatabaseConfig } from './database.config';
