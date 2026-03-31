/**
 * WebModule — HTTP controllers and WebSocket gateways for the Sylphie dashboard.
 *
 * This module owns all external-facing surface area: REST endpoints and
 * WebSocket connections. Epic 9 (E9-T002) completed full DI wiring with all
 * subsystem modules and service integration.
 *
 * Controllers (REST):
 *   HealthController       — GET /api/health (returns database health status)
 *   DrivesController       — GET /api/drives, GET /api/drives/history
 *   GraphController        — GET /api/graph/subgraph, GET /api/graph/stats
 *   ConversationController — GET /api/conversation/history
 *   MetricsController      — GET /api/metrics, GET /api/metrics/drift,
 *                            GET /api/metrics/observatory/* (7 Observatory analytics)
 *   VoiceController        — POST /api/voice/transcribe, POST /api/voice/synthesize
 *   SkillsController       — GET /api/skills, GET /api/skills/:id, DELETE /api/skills/:id,
 *                            POST /api/skills/upload (guardian concept upload)
 *   CameraController       — GET /api/camera/stream (MJPEG via ffmpeg, graceful degradation)
 *
 * Gateways (WebSocket):
 *   TelemetryGateway       — /ws/telemetry  (drive state stream)
 *   ConversationGateway    — /ws/conversation (real-time input/output)
 *   GraphUpdatesGateway    — /ws/graph (incremental WKG diffs)
 *
 * Services:
 *   DatabaseHealthService       — Health checking for all five databases
 *   StartupVerificationService  — Validation at application bootstrap
 *   ConnectionManagerService    — WebSocket connection lifecycle management
 *   ObservatoryService          — Computation for the 7 Observatory analytics endpoints
 *
 * Imports (in dependency order):
 *   KnowledgeModule         — WKG and Self/Other KG services for graph queries
 *   EventsModule            — TimescaleDB event backbone used by all subsystems
 *   DatabaseModule          — PostgreSQL and infrastructure for RLS
 *   DriveEngineModule       — Drive state reader (read-only) for telemetry/metrics
 *   CommunicationModule     — LLM voice and response generation
 *   MetricsModule           — Drift detection and attractor monitoring services
 *
 * CANON §Module boundary: WebModule is the only module allowed to expose HTTP
 * or WebSocket endpoints. No subsystem module (DecisionMaking, Learning, etc.)
 * binds a controller or gateway. External access always goes through WebModule.
 *
 * CANON §DI Tokens: All injected services use Symbol-based tokens for type safety.
 * WebModule does NOT export any subsystem services — it is a read-only consumer.
 */

import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { HealthController } from './controllers/health.controller';
import { DrivesController } from './controllers/drives.controller';
import { GraphController } from './controllers/graph.controller';
import { ConversationController } from './controllers/conversation.controller';
import { MetricsController } from './controllers/metrics.controller';
import { VoiceController } from './controllers/voice.controller';
import { SkillsController } from './controllers/skills.controller';
import { CameraController } from './controllers/camera.controller';
import { DebugController } from './controllers/debug.controller';
import { PressureController } from './controllers/pressure.controller';

import { TelemetryGateway } from './gateways/telemetry.gateway';
import { ConversationGateway } from './gateways/conversation.gateway';
import { GraphUpdatesGateway } from './gateways/graph-updates.gateway';

import { DatabaseHealthService } from './services/database-health.service';
import { StartupVerificationService } from './services/startup-verification.service';
import { ConnectionManagerService } from './services/connection-manager.service';
import { SessionService } from './services/session.service';
import { ObservatoryService } from './services/observatory.service';

import { HttpExceptionFilter } from './filters/http-exception.filter';

import { KnowledgeModule } from '../knowledge/knowledge.module';
import { EventsModule } from '../events/events.module';
import { DatabaseModule } from '../database/database.module';
import { DriveEngineModule } from '../drive-engine/drive-engine.module';
import { CommunicationModule } from '../communication/communication.module';
import { MetricsModule } from '../metrics/metrics.module';

import { CONNECTION_MANAGER, SESSION_SERVICE } from './web.tokens';

@Module({
  imports: [
    KnowledgeModule,
    EventsModule,
    DatabaseModule,
    DriveEngineModule,
    CommunicationModule,
    MetricsModule,
  ],
  controllers: [
    HealthController,
    DrivesController,
    GraphController,
    ConversationController,
    MetricsController,
    VoiceController,
    SkillsController,
    CameraController,
    DebugController,
    PressureController,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    TelemetryGateway,
    ConversationGateway,
    GraphUpdatesGateway,
    DatabaseHealthService,
    StartupVerificationService,
    ObservatoryService,
    {
      provide: CONNECTION_MANAGER,
      useClass: ConnectionManagerService,
    },
    {
      provide: SESSION_SERVICE,
      useClass: SessionService,
    },
  ],
  exports: [CONNECTION_MANAGER, SESSION_SERVICE],
})
export class WebModule {}
