/**
 * DatabaseModule — PostgreSQL schema and connection management.
 *
 * Provides two DI tokens:
 * - POSTGRES_ADMIN_POOL: Internal use only (schema initialization)
 * - POSTGRES_RUNTIME_POOL: Exported for application code
 *
 * On module initialization:
 * 1. Both pools are created from config
 * 2. PostgresInitService runs to create schema, enable RLS, grant permissions
 * 3. Admin pool is closed; runtime pool stays open
 *
 * CANON §Drive Isolation:
 * The two-pool architecture ensures drive_rules cannot be modified by
 * application code. The admin pool is restricted to initialization;
 * the runtime pool sees drive_rules as read-only via RLS.
 *
 * CANON §No Self-Modification (Immutable Standard 6):
 * Sylphie can PROPOSE new drive rules but cannot modify existing ones.
 * This is enforced at the database layer, not at the application layer.
 */

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { POSTGRES_ADMIN_POOL, POSTGRES_RUNTIME_POOL } from './database.tokens';
import { PostgresInitService } from './postgres-init.service';
import { AppConfig } from '../shared/config/app.config';

@Module({
  providers: [
    // Admin pool: DDL + DML, used only for schema initialization
    {
      provide: POSTGRES_ADMIN_POOL,
      useFactory: (config: ConfigService): Pool => {
        const appConfig = config.get<AppConfig>('app');
        if (!appConfig?.postgres) {
          throw new Error('PostgreSQL config not found');
        }

        const pgConfig = appConfig.postgres;
        return new Pool({
          host: pgConfig.host,
          port: pgConfig.port,
          database: pgConfig.database,
          user: pgConfig.adminUser,
          password: pgConfig.adminPassword,
          max: Math.ceil(pgConfig.maxConnections / 2),
          idleTimeoutMillis: pgConfig.idleTimeoutMs,
          connectionTimeoutMillis: pgConfig.connectionTimeoutMs,
        });
      },
      inject: [ConfigService],
    },

    // Runtime pool: SELECT-only (via RLS), used by application code
    {
      provide: POSTGRES_RUNTIME_POOL,
      useFactory: (config: ConfigService): Pool => {
        const appConfig = config.get<AppConfig>('app');
        if (!appConfig?.postgres) {
          throw new Error('PostgreSQL config not found');
        }

        const pgConfig = appConfig.postgres;
        return new Pool({
          host: pgConfig.host,
          port: pgConfig.port,
          database: pgConfig.database,
          user: pgConfig.runtimeUser,
          password: pgConfig.runtimePassword,
          max: Math.floor(pgConfig.maxConnections / 2),
          idleTimeoutMillis: pgConfig.idleTimeoutMs,
          connectionTimeoutMillis: pgConfig.connectionTimeoutMs,
        });
      },
      inject: [ConfigService],
    },

    // Schema initialization service
    PostgresInitService,
  ],

  // Only export the runtime pool; admin pool is module-private
  exports: [POSTGRES_RUNTIME_POOL],
})
export class DatabaseModule {}
