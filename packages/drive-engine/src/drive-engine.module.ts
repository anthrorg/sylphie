/**
 * DriveEngineModule — NestJS client module for Sylphie's motivational subsystem.
 *
 * CANON §Subsystem 4 (Drive Engine): The drive computation runs in a
 * standalone server (apps/drive-server). This module is the client that
 * connects via WebSocket and exposes drive state to the rest of the app.
 *
 * EXPORTED tokens (public API for other modules):
 *   DRIVE_STATE_READER       — Read-only drive state facade (IDriveStateReader)
 *   ACTION_OUTCOME_REPORTER  — Fire-and-forget write channel (IActionOutcomeReporter)
 *   RULE_PROPOSER            — Guardian-gated rule proposals (IRuleProposer)
 *
 * CANON §Drive Isolation: The main app communicates with the drive engine
 * exclusively through the WebSocket wire protocol. It has no access to drive
 * rules, accumulation rates, or internal state — only the resulting snapshots.
 */

import { Module, OnModuleInit, OnModuleDestroy, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { POSTGRES_RUNTIME_POOL } from '@sylphie/shared';
import {
  DRIVE_STATE_READER,
  ACTION_OUTCOME_REPORTER,
  RULE_PROPOSER,
  DRIVE_PROCESS_MANAGER,
} from './drive-engine.tokens';
import { DriveReaderService } from './drive-reader.service';
import { ActionOutcomeReporterService } from './action-outcome-reporter.service';
import { RuleProposerService } from './rule-proposer.service';
import { DriveProcessManagerService } from './drive-process/drive-process-manager.service';
import { PostgresRulesClient } from './rule-proposer/postgres-rules-client';
import { WsChannelService } from './ipc-channel/ws-channel.service';

@Module({
  providers: [
    // PostgreSQL runtime pool for rule proposals (RLS-enforced)
    {
      provide: POSTGRES_RUNTIME_POOL,
      useFactory: (config: ConfigService): Pool => {
        return new Pool({
          host: config.get('postgres.host', 'localhost'),
          port: config.get('postgres.port', 5434),
          database: config.get('postgres.database', 'sylphie_system'),
          user: config.get('postgres.runtimeUser', 'sylphie_app'),
          password: config.get('postgres.runtimePassword', 'sylphie_app_dev'),
          max: 5,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        });
      },
      inject: [ConfigService],
    },
    // PostgreSQL client for rule proposals (runs in main app, writes to shared DB)
    PostgresRulesClient,
    // WebSocket channel for Drive Engine server communication
    WsChannelService,
    // DriveReaderService must be registered under its class token so that
    // DriveProcessManagerService can inject it directly by class reference.
    // The DRIVE_STATE_READER symbol token aliases the same singleton instance
    // so external consumers using the interface token get the same object.
    DriveReaderService,
    {
      provide: DRIVE_STATE_READER,
      useExisting: DriveReaderService,
    },
    {
      provide: ACTION_OUTCOME_REPORTER,
      useClass: ActionOutcomeReporterService,
    },
    {
      provide: RULE_PROPOSER,
      useClass: RuleProposerService,
    },
    {
      provide: DRIVE_PROCESS_MANAGER,
      useClass: DriveProcessManagerService,
    },
  ],
  exports: [
    DRIVE_STATE_READER,
    ACTION_OUTCOME_REPORTER,
    RULE_PROPOSER,
  ],
})
export class DriveEngineModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DriveEngineModule.name);

  constructor(
    @Inject(DRIVE_PROCESS_MANAGER)
    private readonly processManager: DriveProcessManagerService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Connecting to Drive Engine server...');
    await this.processManager.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Disconnecting from Drive Engine server...');
    await this.processManager.stop();
  }
}
