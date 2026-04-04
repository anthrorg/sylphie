import { registerAs } from '@nestjs/config';

export const neo4jConfig = registerAs('neo4j', () => ({
  world: {
    uri: process.env.NEO4J_WORLD_URI!,
    user: process.env.NEO4J_WORLD_USER!,
    password: process.env.NEO4J_WORLD_PASSWORD!,
    database: process.env.NEO4J_WORLD_DATABASE || 'neo4j',
    maxConnectionPoolSize: parseInt(process.env.NEO4J_WORLD_MAX_CONNECTION_POOL_SIZE || '50', 10),
    connectionTimeoutMs: parseInt(process.env.NEO4J_WORLD_CONNECTION_TIMEOUT_MS || '5000', 10),
  },
  self: {
    uri: process.env.NEO4J_SELF_URI!,
    user: process.env.NEO4J_SELF_USER!,
    password: process.env.NEO4J_SELF_PASSWORD!,
    database: process.env.NEO4J_SELF_DATABASE || 'neo4j',
    maxConnectionPoolSize: parseInt(process.env.NEO4J_SELF_MAX_CONNECTION_POOL_SIZE || '50', 10),
    connectionTimeoutMs: parseInt(process.env.NEO4J_SELF_CONNECTION_TIMEOUT_MS || '5000', 10),
  },
  other: {
    uri: process.env.NEO4J_OTHER_URI!,
    user: process.env.NEO4J_OTHER_USER!,
    password: process.env.NEO4J_OTHER_PASSWORD!,
    database: process.env.NEO4J_OTHER_DATABASE || 'neo4j',
    maxConnectionPoolSize: parseInt(process.env.NEO4J_OTHER_MAX_CONNECTION_POOL_SIZE || '50', 10),
    connectionTimeoutMs: parseInt(process.env.NEO4J_OTHER_CONNECTION_TIMEOUT_MS || '5000', 10),
  },
}));

export const timescaleConfig = registerAs('timescale', () => ({
  host: process.env.TIMESCALE_HOST || 'localhost',
  port: parseInt(process.env.TIMESCALE_PORT || '5433', 10),
  database: process.env.TIMESCALE_DB || 'sylphie_events',
  user: process.env.TIMESCALE_USER!,
  password: process.env.TIMESCALE_PASSWORD!,
  maxConnections: parseInt(process.env.TIMESCALE_MAX_CONNECTIONS || '20', 10),
  idleTimeoutMs: parseInt(process.env.TIMESCALE_IDLE_TIMEOUT_MS || '30000', 10),
  connectionTimeoutMs: parseInt(process.env.TIMESCALE_CONNECTION_TIMEOUT_MS || '5000', 10),
  retentionDays: parseInt(process.env.TIMESCALE_RETENTION_DAYS || '90', 10),
  compressionDays: parseInt(process.env.TIMESCALE_COMPRESSION_DAYS || '7', 10),
}));

export const postgresConfig = registerAs('postgres', () => ({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5434', 10),
  database: process.env.POSTGRES_DB || 'sylphie_system',
  adminUser: process.env.POSTGRES_ADMIN_USER!,
  adminPassword: process.env.POSTGRES_ADMIN_PASSWORD!,
  runtimeUser: process.env.POSTGRES_RUNTIME_USER!,
  runtimePassword: process.env.POSTGRES_RUNTIME_PASSWORD!,
  maxConnections: parseInt(process.env.POSTGRES_MAX_CONNECTIONS || '10', 10),
  idleTimeoutMs: parseInt(process.env.POSTGRES_IDLE_TIMEOUT_MS || '30000', 10),
  connectionTimeoutMs: parseInt(process.env.POSTGRES_CONNECTION_TIMEOUT_MS || '5000', 10),
}));
