/**
 * KnowledgeModule — all knowledge graph services for Sylphie.
 *
 * Provides four service interfaces and one infrastructure token:
 *
 * - WKG_SERVICE       → WkgService       (IWkgService)
 * - SELF_KG_SERVICE   → SelfKgService    (ISelfKgService)
 * - OTHER_KG_SERVICE  → OtherKgService   (IOtherKgService)
 * - CONFIDENCE_SERVICE→ ConfidenceService(IConfidenceService)
 * - NEO4J_DRIVER      → Real neo4j-driver instance with pooling + constraints
 *
 * Only the four service tokens are exported — NEO4J_DRIVER is an internal
 * infrastructure token that only WkgService holds. No external module injects
 * the driver directly.
 *
 * Neo4jInitService runs OnModuleInit to set up idempotent constraints and schema.
 *
 * CANON §Module boundary: Consumers import from the barrel (index.ts) and
 * inject by token, never by concrete class. KnowledgeModule is imported by
 * every subsystem module that requires graph access.
 *
 * CANON §Drive Isolation: KnowledgeModule does NOT import DriveEngineModule.
 * Drive state flows one way: out of DriveEngineModule via read-only facade.
 * Knowledge graph writes never depend on drive state at the module level.
 */

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import neo4j from 'neo4j-driver';
import { WkgService } from './wkg.service';
import { SelfKgService } from './self-kg.service';
import { OtherKgService } from './other-kg.service';
import { ConfidenceService } from './confidence.service';
import { Neo4jInitService } from './neo4j-init.service';
import {
  WKG_SERVICE,
  SELF_KG_SERVICE,
  OTHER_KG_SERVICE,
  CONFIDENCE_SERVICE,
  NEO4J_DRIVER,
} from './knowledge.tokens';
import type { AppConfig } from '../shared/config/app.config';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [EventsModule],
  providers: [
    /**
     * NEO4J_DRIVER — Factory provider that creates a real neo4j-driver instance.
     *
     * Injects ConfigService to read Neo4j connection parameters:
     * - URI, user, password, database
     * - Connection pool size (default 50)
     * - Connection timeout (default 5000ms)
     *
     * The driver is used only by WkgService. Neo4jInitService runs OnModuleInit
     * to set up constraints and indexes idempotently.
     */
    {
      provide: NEO4J_DRIVER,
      useFactory: (config: ConfigService) => {
        const appConfig = config.get<AppConfig>('app');
        if (!appConfig || !appConfig.neo4j) {
          throw new Error(
            'NEO4J_DRIVER factory: AppConfig or neo4j config is missing',
          );
        }

        const neo4jConfig = appConfig.neo4j;
        return neo4j.driver(
          neo4jConfig.uri,
          neo4j.auth.basic(neo4jConfig.user, neo4jConfig.password),
          {
            maxConnectionPoolSize: neo4jConfig.maxConnectionPoolSize,
            connectionTimeout: neo4jConfig.connectionTimeoutMs,
          },
        );
      },
      inject: [ConfigService],
    },

    /**
     * Neo4jInitService — Initialization and health check for Neo4j.
     *
     * OnModuleInit runs idempotent constraint and schema setup.
     * OnModuleDestroy closes the driver gracefully.
     */
    Neo4jInitService,

    {
      provide: WKG_SERVICE,
      useClass: WkgService,
    },

    {
      provide: SELF_KG_SERVICE,
      useClass: SelfKgService,
    },

    {
      provide: OTHER_KG_SERVICE,
      useClass: OtherKgService,
    },

    {
      provide: CONFIDENCE_SERVICE,
      useClass: ConfidenceService,
    },
  ],
  exports: [
    WKG_SERVICE,
    SELF_KG_SERVICE,
    OTHER_KG_SERVICE,
    CONFIDENCE_SERVICE,
    Neo4jInitService,
  ],
})
export class KnowledgeModule {}
