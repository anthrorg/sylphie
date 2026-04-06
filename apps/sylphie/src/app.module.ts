import * as path from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  PrismaModule,
  TimescaleModule,
  Neo4jModule,
  Neo4jInstanceName,
  neo4jConfig,
  timescaleConfig,
  postgresConfig,
  ollamaConfig,
  voiceConfig,
} from '@sylphie/shared';
import { DecisionMakingModule } from '@sylphie/decision-making';
import { DriveEngineModule } from '@sylphie/drive-engine';
import { GraphController } from './controllers/graph.controller';
import { SkillsController } from './controllers/skills.controller';
import { DrivesController, PressureController } from './controllers/drives.controller';
import { VoiceController } from './controllers/voice.controller';
import { MetricsController } from './controllers/metrics.controller';
import { DebugController } from './controllers/debug.controller';
import { AuthController } from './controllers/auth.controller';
import { GraphGateway } from './gateways/graph.gateway';
import { ConversationGateway } from './gateways/conversation.gateway';
import { TelemetryGateway } from './gateways/telemetry.gateway';
import { PerceptionGateway } from './gateways/perception.gateway';
import { AudioGateway } from './gateways/audio.gateway';
import { SensoryLoggerService } from './services/sensory-logger.service';
import { DrivePublisherService } from './services/drive-publisher.service';
import { WkgQueryService } from './services/wkg-query.service';
import { WkgBootstrapService } from './services/wkg-bootstrap.service';
import { SttService } from './services/stt.service';
import { TtsService } from './services/tts.service';
import { CommunicationService } from './services/communication.service';
import { ConversationHistoryService } from './services/conversation-history.service';
import { PersonModelService } from './services/person-model.service';
import { VoiceLatentSpaceService } from './services/voice-latent-space.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: path.resolve(process.cwd(), '.env'),
      load: [neo4jConfig, timescaleConfig, postgresConfig, ollamaConfig, voiceConfig],
    }),
    PrismaModule,
    TimescaleModule,
    DriveEngineModule,
    DecisionMakingModule,
    Neo4jModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        instances: [
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
        ],
      }),
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
    DebugController,
  ],
  providers: [
    // Sensory pipeline providers are now inside DecisionMakingModule
    SensoryLoggerService,
    DrivePublisherService,
    WkgQueryService,
    WkgBootstrapService,
    SttService,
    TtsService,
    // Communication subsystem
    CommunicationService,
    ConversationHistoryService,
    PersonModelService,
    VoiceLatentSpaceService,
    // Gateways
    GraphGateway,
    ConversationGateway,
    TelemetryGateway,
    PerceptionGateway,
    AudioGateway,
  ],
})
export class AppModule {}
