import * as path from 'path';
import { Module, Global, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { Pool } from 'pg';
import {
  PrismaModule,
  TimescaleModule,
  Neo4jModule,
  Neo4jInstanceName,
  POSTGRES_RUNTIME_POOL,
  POSTGRES_GUARDIAN_POOL,
  neo4jConfig,
  timescaleConfig,
  postgresConfig,
  ollamaConfig,
  voiceConfig,
} from '@sylphie/shared';
import { DecisionMakingModule, TENSOR_INFERENCE_SERVICE } from '@sylphie/decision-making';
import { LearningModule } from '@sylphie/learning';
import { PlanningModule } from '@sylphie/planning';
import { DriveEngineModule } from '@sylphie/drive-engine';
import { SupervisorModule } from '@sylphie/supervisor';
import { GraphController } from './controllers/graph.controller';
import { SkillsController } from './controllers/skills.controller';
import { DrivesController, PressureController } from './controllers/drives.controller';
import { VoiceController } from './controllers/voice.controller';
import { MetricsController } from './controllers/metrics.controller';
import { LlmController } from './controllers/llm.controller';
import { FeAgentController } from './controllers/fe-agent.controller';
import { AuthController } from './controllers/auth.controller';
import { SupervisorController } from './controllers/supervisor.controller';
import { RulesController } from './controllers/rules.controller';
import { CognitionController } from './controllers/cognition.controller';
import { HealthController } from './controllers/health.controller';
import { GraphGateway } from './gateways/graph.gateway';
import { ConversationGateway } from './gateways/conversation.gateway';
import { TelemetryGateway } from './gateways/telemetry.gateway';
import { PerceptionGateway } from './gateways/perception.gateway';
import { AudioGateway } from './gateways/audio.gateway';
import { SupervisorGateway } from './gateways/supervisor.gateway';
import { SensoryLoggerService } from './services/sensory-logger.service';
import { DrivePublisherService } from './services/drive-publisher.service';
import { WkgQueryService } from './services/wkg-query.service';
import { WkgBootstrapService } from './services/wkg-bootstrap.service';
import { WkgDiffService } from './services/wkg-diff.service';
import { SelfAssessmentService } from './services/self-assessment.service';
import { SelfAssessmentPusherService } from './services/self-assessment-pusher.service';
import { SttService } from './services/stt.service';
import { TtsService } from './services/tts.service';
import { CommunicationService } from './services/communication.service';
import { CycleOutcomeReporterService } from './services/cycle-outcome-reporter.service';
import { FastFactWriterService } from './services/fast-fact-writer.service';
import { ConversationHistoryService } from './services/conversation-history.service';
import { PersonModelService } from './services/person-model.service';
import { FaceSnapshotService } from './services/face-snapshot.service';
import { VoiceLatentSpaceService } from './services/voice-latent-space.service';
import { SceneEventDetectorService } from './services/scene-event-detector.service';
import { VisualWorkingMemoryService } from './services/visual-working-memory.service';
import { BindingService } from './services/binding.service';
import { TelemetryBroadcastService } from './services/telemetry-broadcast.service';
import { SupervisorBroadcastService } from './services/supervisor-broadcast.service';
import { CognitionGatewayService } from './services/cognition-gateway.service';
import { CognitionBridgeService } from './services/cognition-bridge.service';
import { TensorInferenceAdapter } from './services/tensor-inference-adapter.service';
import { GuardianRulesService } from './services/guardian-rules.service';
import { createGuardianPool } from './services/guardian-pool.provider';
import { LearningPressureBridgeService } from './services/learning-pressure-bridge.service';

/**
 * @Global() CognitionModule — makes TENSOR_INFERENCE_SERVICE available to
 * DecisionMakingService without DecisionMakingModule importing an app-level
 * module (which would violate the packages/ → apps/ layering constraint).
 *
 * Follows the same pattern as TimescaleModule (also @Global()).
 */
@Global()
@Module({
  providers: [
    CognitionGatewayService,
    {
      provide: TENSOR_INFERENCE_SERVICE,
      useClass: TensorInferenceAdapter,
    },
  ],
  exports: [
    CognitionGatewayService,
    TENSOR_INFERENCE_SERVICE,
  ],
})
class CognitionModule {}

const pgPoolLogger = new Logger('PostgresPool');

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: path.resolve(process.cwd(), '.env'),
      load: [neo4jConfig, timescaleConfig, postgresConfig, ollamaConfig, voiceConfig],
    }),
    // Serve the Vite-built frontend in production (no-op when dir is absent)
    ...(process.env.NODE_ENV === 'production'
      ? [
          ServeStaticModule.forRoot({
            rootPath: path.resolve(process.cwd(), 'frontend', 'dist'),
            exclude: ['/api/*splat', '/ws/*splat'],
          }),
        ]
      : []),
    PrismaModule,
    TimescaleModule,
    DriveEngineModule,
    DecisionMakingModule,
    LearningModule,
    PlanningModule,
    SupervisorModule,
    CognitionModule,
    Neo4jModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const instances = [
          {
            name: Neo4jInstanceName.WORLD,
            uri: config.get('neo4j.world.uri')!,
            user: config.get('neo4j.world.user')!,
            password: config.get('neo4j.world.password')!,
            database: config.get('neo4j.world.database')!,
            maxConnectionPoolSize: config.get('neo4j.world.maxConnectionPoolSize')!,
            connectionTimeoutMs: config.get('neo4j.world.connectionTimeoutMs')!,
          },
          {
            name: Neo4jInstanceName.SELF,
            uri: config.get('neo4j.self.uri')!,
            user: config.get('neo4j.self.user')!,
            password: config.get('neo4j.self.password')!,
            database: config.get('neo4j.self.database')!,
            maxConnectionPoolSize: config.get('neo4j.self.maxConnectionPoolSize')!,
            connectionTimeoutMs: config.get('neo4j.self.connectionTimeoutMs')!,
          },
          {
            name: Neo4jInstanceName.OTHER,
            uri: config.get('neo4j.other.uri')!,
            user: config.get('neo4j.other.user')!,
            password: config.get('neo4j.other.password')!,
            database: config.get('neo4j.other.database')!,
            maxConnectionPoolSize: config.get('neo4j.other.maxConnectionPoolSize')!,
            connectionTimeoutMs: config.get('neo4j.other.connectionTimeoutMs')!,
          },
        ];
        return { instances };
      },
    }),
  ],
  controllers: [
    AuthController,
    GraphController,
    SkillsController,
    DrivesController,
    PressureController,
    VoiceController,
    MetricsController,
    LlmController,
    FeAgentController,
    SupervisorController,
    RulesController,
    CognitionController,
    HealthController,
  ],
  providers: [
    // PostgreSQL runtime pool — read access for guardian rule management
    // (SELECT-only on drive_rules/proposed_drive_rules after TK-154).
    {
      provide: POSTGRES_RUNTIME_POOL,
      useFactory: (config: ConfigService): Pool => {
        const pool = new Pool({
          host: config.get('postgres.host', 'localhost'),
          port: config.get('postgres.port', 5434),
          database: config.get('postgres.database', 'sylphie_system'),
          user: config.get('postgres.runtimeUser', 'sylphie_app'),
          password: config.get('postgres.runtimePassword', 'sylphie_app_dev'),
          max: 3,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        });
        // Hygiene (TK-155 review): an idle-client error with no 'error'
        // listener is an unhandled event that crashes the process. Log it
        // instead — the pool itself recovers idle-client failures on its own.
        pool.on('error', (err) =>
          pgPoolLogger.error(`runtime pool idle client error: ${err.message}`, err.stack),
        );
        return pool;
      },
      inject: [ConfigService],
    },
    // PostgreSQL guardian pool (TK-155) — privileged write access ONLY.
    // Used exclusively by GuardianRulesService.approveRule/rejectRule to
    // promote/reject a proposed drive rule. Fails closed (not app-crash) if
    // POSTGRES_GUARDIAN_USER/PASSWORD are unset — see
    // ./services/guardian-pool.provider.ts and CANON Immutable Standard 6.
    // NO hardcoded credential default: unlike the runtime pool above, there
    // is no dev fallback user/password here.
    {
      provide: POSTGRES_GUARDIAN_POOL,
      useFactory: (config: ConfigService): Pool => {
        const pool = createGuardianPool({
          host: config.get('postgres.host', 'localhost'),
          port: config.get('postgres.port', 5434),
          database: config.get('postgres.database', 'sylphie_system'),
          user: config.get('postgres.guardianUser'),
          password: config.get('postgres.guardianPassword'),
          max: 2,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        });
        // Hygiene (TK-155 review): same idle-client 'error' exposure as the
        // runtime pool above. A no-op on the unconfigured stand-in.
        pool.on('error', (err) =>
          pgPoolLogger.error(`guardian pool idle client error: ${err.message}`, err.stack),
        );
        return pool;
      },
      inject: [ConfigService],
    },
    GuardianRulesService,
    // Sensory pipeline providers are now inside DecisionMakingModule
    SensoryLoggerService,
    DrivePublisherService,
    WkgQueryService,
    WkgBootstrapService,
    // Phase 4 Wave 2 (3a) graph-compute layer — atlas side of the event-judge
    // model. These compute graph values; the apps push agent wires the cadence
    // and reporter that send the events for the drive to judge.
    WkgDiffService,
    SelfAssessmentService,
    // Ticket 1 push producer: ~10s cadence, coalesced ≤1/interval. Pushes the
    // SELF_ASSESSMENT event the drive judges (event-judge model, no read path).
    SelfAssessmentPusherService,
    SttService,
    TtsService,
    // Communication subsystem
    // TK-34 (EP7-D): FastFactWriterService carries the 4 KG-write deps extracted
    // from CommunicationService (Neo4jService ×2, WkgDiffService, outcomeReporter).
    FastFactWriterService,
    // TK-35 (EP7-E): theater check + basic outcome reporting extracted from
    // CommunicationService; must be provided before CommunicationService resolves.
    CycleOutcomeReporterService,
    CommunicationService,
    ConversationHistoryService,
    PersonModelService,
    FaceSnapshotService,
    VoiceLatentSpaceService,
    SceneEventDetectorService,
    VisualWorkingMemoryService,
    BindingService,
    TelemetryBroadcastService,
    SupervisorBroadcastService,
    CognitionBridgeService,
    // Learning pressure bridge: triggers maintenance cycles when CognitiveAwareness > 0.70
    LearningPressureBridgeService,
    // Gateways
    GraphGateway,
    ConversationGateway,
    TelemetryGateway,
    PerceptionGateway,
    AudioGateway,
    SupervisorGateway,
  ],
})
export class AppModule {}
