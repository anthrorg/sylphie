/**
 * EventsModule — TimescaleDB event backbone.
 *
 * Provides IEventService under the EVENTS_SERVICE token. All five subsystem
 * modules import EventsModule to gain access to event recording and querying.
 *
 * Only EVENTS_SERVICE is exported. EventsService is an internal implementation
 * detail; consumers depend on the interface, not the class.
 *
 * CANON §TimescaleDB — The Event Backbone: every subsystem event flows through
 * this module. No direct TimescaleDB clients outside this module boundary.
 */

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { EventsService } from './events.service';
import { TimescaleInitService } from './timescale-init.service';
import { EVENTS_SERVICE, TIMESCALEDB_POOL } from './events.tokens';
import type { AppConfig } from '../shared/config/app.config';

@Module({
  providers: [
    {
      provide: TIMESCALEDB_POOL,
      useFactory: (config: ConfigService): Pool => {
        const appConfig = config.get<AppConfig>('app');
        const tsConfig = appConfig?.timescale;

        if (!tsConfig) {
          throw new Error('TimescaleDB configuration not found');
        }

        return new Pool({
          host: tsConfig.host,
          port: tsConfig.port,
          database: tsConfig.database,
          user: tsConfig.user,
          password: tsConfig.password,
          max: tsConfig.maxConnections,
          idleTimeoutMillis: tsConfig.idleTimeoutMs,
          connectionTimeoutMillis: tsConfig.connectionTimeoutMs,
        });
      },
      inject: [ConfigService],
    },
    TimescaleInitService,
    {
      provide: EVENTS_SERVICE,
      useClass: EventsService,
    },
  ],
  exports: [EVENTS_SERVICE, TIMESCALEDB_POOL, TimescaleInitService],
})
export class EventsModule {}
