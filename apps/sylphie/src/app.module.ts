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
} from '@sylphie/shared';
import {
  ModalityRegistryService,
  TextEncoder,
  VideoEncoder,
  DriveEncoder,
  SensoryFusionService,
  TickSamplerService,
} from '@sylphie/decision-making';
import { GraphController } from './controllers/graph.controller';
import { SkillsController } from './controllers/skills.controller';
import { DrivesController } from './controllers/drives.controller';
import { VoiceController } from './controllers/voice.controller';
import { MetricsController } from './controllers/metrics.controller';
import { DebugController } from './controllers/debug.controller';
import { AuthController } from './controllers/auth.controller';
import { GraphGateway } from './gateways/graph.gateway';
import { ConversationGateway } from './gateways/conversation.gateway';
import { TelemetryGateway } from './gateways/telemetry.gateway';
import { PerceptionGateway } from './gateways/perception.gateway';
import { SensoryLoggerService } from './services/sensory-logger.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: path.resolve(process.cwd(), '.env'),
      load: [neo4jConfig, timescaleConfig, postgresConfig, ollamaConfig],
    }),
    PrismaModule,
    TimescaleModule,
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
    VoiceController,
    MetricsController,
    DebugController,
  ],
  providers: [
    // Sensory pipeline
    ModalityRegistryService,
    TextEncoder,
    VideoEncoder,
    DriveEncoder,
    SensoryFusionService,
    TickSamplerService,
    SensoryLoggerService,
    // Gateways
    GraphGateway,
    ConversationGateway,
    TelemetryGateway,
    PerceptionGateway,
  ],
})
export class AppModule {}
