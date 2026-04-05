/**
 * DriveEngineModule — NestJS module for Sylphie's motivational subsystem.
 *
 * CANON §Subsystem 4 (Drive Engine): Computes motivational state (12 drives),
 * evaluates actions, detects opportunities, and runs in an isolated process.
 *
 * EXPORTED tokens (public API for other modules):
 *   DRIVE_STATE_READER       — Read-only drive state facade (IDriveStateReader)
 *   ACTION_OUTCOME_REPORTER  — Fire-and-forget IPC write channel (IActionOutcomeReporter)
 *   RULE_PROPOSER            — Guardian-gated rule proposals (IRuleProposer)
 *
 * NOT EXPORTED (internal only):
 *   DRIVE_PROCESS_MANAGER    — Child process lifecycle (IDriveProcessManager)
 *   This is intentionally hidden: no other module should depend on process
 *   management. Exposing it would create coupling to infrastructure internals
 *   and risk boundary violations that could compromise drive isolation.
 *
 * CANON §Drive Isolation: Other subsystems may read drive state and report
 * outcomes, but they cannot modify the evaluation function. The isolation
 * boundary is structural — only DriveProcessManagerService can communicate
 * with the child process, and only inbound IPC data (snapshots) is forwarded
 * to the public IDriveStateReader facade.
 *
 * Import dependencies: None in E0 (ConfigModule will be added when the real
 * implementation needs database credentials for RuleProposerService).
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
import { RlsVerificationService } from './postgres-verification/verify-rls';
import { PostgresRulesClient } from './rule-proposer/postgres-rules-client';
import { IpcChannelService } from './ipc-channel/ipc-channel.service';

@Module({
  providers: [
    // PostgreSQL runtime pool for rule lookups (RLS-enforced read-only)
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
    // RLS verification happens on module init
    RlsVerificationService,
    // PostgreSQL client for rule operations
    PostgresRulesClient,
    // IPC channel is shared by DriveProcessManagerService and ActionOutcomeReporterService
    IpcChannelService,
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
    // Public API: read-side tokens only
    DRIVE_STATE_READER,
    ACTION_OUTCOME_REPORTER,
    RULE_PROPOSER,
    // DRIVE_PROCESS_MANAGER is intentionally NOT exported — internal only
  ],
})
export class DriveEngineModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DriveEngineModule.name);

  constructor(
    @Inject(DRIVE_PROCESS_MANAGER)
    private readonly processManager: DriveProcessManagerService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Starting Drive Engine...');
    await this.processManager.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Stopping Drive Engine...');
    await this.processManager.stop();
  }
}
