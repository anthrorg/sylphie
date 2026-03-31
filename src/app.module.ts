/**
 * Root application module — wires all eleven NestJS modules together.
 *
 * Import order follows dependency direction (infrastructure first, then
 * subsystems, then utilities, then web surface):
 *
 *   SharedModule          — @Global() ConfigModule. Must be first so that
 *                           ConfigService is available to all other modules
 *                           via the global scope. Only imported here.
 *
 *   EventsModule          — TimescaleDB event backbone. Provides EVENTS_SERVICE
 *                           to all five subsystem modules.
 *
 *   KnowledgeModule       — WKG + Self/Other KG services. Provides WKG_SERVICE,
 *                           SELF_KG_SERVICE, OTHER_KG_SERVICE, CONFIDENCE_SERVICE.
 *
 *   DriveEngineModule     — Motivational subsystem. Provides DRIVE_STATE_READER
 *                           (read-only facade), ACTION_OUTCOME_REPORTER, and
 *                           RULE_PROPOSER. Manages the isolated drive process.
 *
 *   DecisionMakingModule  — Cognitive loop. Imports DriveEngineModule for the
 *                           read-only drive state facade.
 *
 *   CommunicationModule   — Input parsing, LLM voice, TTS/STT. Provides
 *                           LLM_SERVICE for Learning and Planning.
 *
 *   LearningModule        — Experience-to-knowledge pipeline. Maintenance cycles,
 *                           entity extraction, edge refinement, contradiction
 *                           detection.
 *
 *   PlanningModule        — Opportunity-driven plan creation. Simulates outcomes
 *                           and writes validated procedure nodes to the WKG.
 *
 *   MetricsModule         — Health metrics, drift detection, attractor monitoring.
 *                           Available in both dev/test and production.
 *
 *   TestingModule         — Test infrastructure and lesion modes (dev/test only).
 *                           Conditionally imported when NODE_ENV !== 'production'.
 *
 *   WebModule             — REST controllers and WebSocket gateways. The only
 *                           module that exposes HTTP/WS endpoints.
 *
 *   MediaModule           — WebRTC signaling gateway at /ws/media. Self-contained;
 *                           does not import any subsystem module. Media sessions
 *                           are transient and carry no provenance.
 *
 * CANON §Module boundary: AppModule is the composition root. It does not
 * contain any business logic or providers — it only assembles the module graph.
 *
 * CANON §Drive Isolation: DriveEngineModule is listed before subsystem modules
 * so that its exported tokens (DRIVE_STATE_READER etc.) are available when
 * DecisionMakingModule resolves its imports. NestJS handles this automatically
 * via DI, but explicit ordering makes the dependency direction visible.
 */

import { Module } from '@nestjs/common';

import { SharedModule } from './shared/shared.module';
import { DatabaseModule } from './database/database.module';
import { EventsModule } from './events/events.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { DriveEngineModule } from './drive-engine/drive-engine.module';
import { DecisionMakingModule } from './decision-making/decision-making.module';
import { CommunicationModule } from './communication/communication.module';
import { LearningModule } from './learning/learning.module';
import { PlanningModule } from './planning/planning.module';
import { MetricsModule } from './metrics/metrics.module';
import { TestingModule } from './testing/testing.module';
import { WebModule } from './web/web.module';
import { MediaModule } from './media/media.module';

@Module({
  imports: [
    SharedModule,
    DatabaseModule,
    EventsModule,
    KnowledgeModule,
    DriveEngineModule,
    DecisionMakingModule,
    CommunicationModule,
    LearningModule,
    PlanningModule,
    MetricsModule,
    ...(process.env.NODE_ENV !== 'production' ? [TestingModule] : []),
    WebModule,
    MediaModule,
  ],
})
export class AppModule {}
