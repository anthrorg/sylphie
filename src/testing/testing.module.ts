/**
 * TestingModule — DI wiring for test infrastructure (dev/test only).
 *
 * Conditionally registered in AppModule only when NODE_ENV !== 'production'.
 * Provides the ITestEnvironment service and internal lesion mode implementations.
 *
 * Imports all five subsystem modules to enable bootstrapping the full system
 * in various lesion modes. Lesion services are providers (not exported) because
 * the public API only exposes TestMode strings; the implementation manages
 * the actual disabling logic.
 *
 * CANON §Module boundary: Consumers import from the barrel (index.ts) and
 * inject TEST_ENVIRONMENT by token, never by concrete class.
 */

import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { DriveEngineModule } from '../drive-engine/drive-engine.module';
import { DecisionMakingModule } from '../decision-making/decision-making.module';
import { CommunicationModule } from '../communication/communication.module';
import { LearningModule } from '../learning/learning.module';
import { PlanningModule } from '../planning/planning.module';
import { TEST_ENVIRONMENT } from './interfaces/testing.tokens';
import { TestEnvironmentService } from './test-environment.service';
import { DatabaseFixturesService } from './database-fixtures.service';
import { LesionNoLlmService } from './lesion-modes/lesion-no-llm.service';
import { LesionNoWkgService } from './lesion-modes/lesion-no-wkg.service';
import { LesionNoDrivesService } from './lesion-modes/lesion-no-drives.service';

@Module({
  imports: [
    EventsModule,
    KnowledgeModule,
    DriveEngineModule,
    DecisionMakingModule,
    CommunicationModule,
    LearningModule,
    PlanningModule,
  ],
  providers: [
    {
      provide: TEST_ENVIRONMENT,
      useClass: TestEnvironmentService,
    },
    DatabaseFixturesService,
    LesionNoLlmService,
    LesionNoWkgService,
    LesionNoDrivesService,
  ],
  exports: [TEST_ENVIRONMENT],
})
export class TestingModule {}
