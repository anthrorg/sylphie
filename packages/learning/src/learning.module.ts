/**
 * LearningModule — NestJS module for Sylphie's Learning subsystem.
 *
 * CANON §Subsystem 3 (Learning): The consolidation pipeline converts raw
 * experience (TimescaleDB events with has_learned = false) into durable
 * knowledge in the World Knowledge Graph (Neo4j WORLD).
 *
 * PUBLIC API (exported from index.ts):
 *   LEARNING_SERVICE — ILearningService, the sole external facade.
 *
 * INTERNAL providers (not exported from index.ts):
 *   UPDATE_WKG_SERVICE, UPSERT_ENTITIES_SERVICE, EXTRACT_EDGES_SERVICE,
 *   CONVERSATION_ENTRY_SERVICE, CAN_PRODUCE_EDGES_SERVICE,
 *   REFINE_EDGES_SERVICE, LEARNING_EVENT_LOGGER
 *
 * Dependencies:
 *   - DecisionMakingModule: provides LLM_SERVICE (OllamaLlmService) and
 *     WkgContextService. Importing this module gives Learning access to the
 *     LLM without creating a direct dependency on OllamaLlmService.
 *   - TimescaleModule: @Global() but explicitly imported for DI clarity.
 *
 * CANON §No Circular Module Dependencies: LearningModule only imports
 * DecisionMakingModule (which imports DriveEngineModule). It does not import
 * CommunicationModule or PlanningModule.
 */

import { Module } from '@nestjs/common';
import { DecisionMakingModule } from '@sylphie/decision-making';
import { TimescaleModule } from '@sylphie/shared';

import {
  LEARNING_SERVICE,
  UPDATE_WKG_SERVICE,
  UPSERT_ENTITIES_SERVICE,
  EXTRACT_EDGES_SERVICE,
  CONVERSATION_ENTRY_SERVICE,
  CAN_PRODUCE_EDGES_SERVICE,
  REFINE_EDGES_SERVICE,
  CONVERSATION_REFLECTION_SERVICE,
  CROSS_SESSION_SYNTHESIS_SERVICE,
  LEARNING_EVENT_LOGGER,
} from './learning.tokens';

import { LearningService } from './learning.service';
import { UpdateWkgService } from './pipeline/update-wkg.service';
import { UpsertEntitiesService } from './pipeline/upsert-entities.service';
import { ExtractEdgesService } from './pipeline/extract-edges.service';
import { ConversationEntryService } from './pipeline/conversation-entry.service';
import { CanProduceEdgesService } from './pipeline/can-produce-edges.service';
import { RefineEdgesService } from './pipeline/refine-edges.service';
import { ConversationReflectionService } from './pipeline/conversation-reflection.service';
import { CrossSessionSynthesisService } from './pipeline/cross-session-synthesis.service';
import { LearningEventLoggerService } from './logging/learning-event-logger.service';

@Module({
  imports: [
    // DecisionMakingModule exports: LLM_SERVICE, WkgContextService, and the
    // full sensory pipeline. Learning uses LLM_SERVICE for edge refinement.
    DecisionMakingModule,
    // Explicit import even though TimescaleModule is @Global() — ensures DI
    // resolution order is correct when services use @Optional() injection.
    TimescaleModule,
  ],
  providers: [
    // ── Public facade ────────────────────────────────────────────────────────
    {
      provide: LEARNING_SERVICE,
      useClass: LearningService,
    },

    // ── Pipeline step 2: TimescaleDB schema + event fetch ───────────────────
    {
      provide: UPDATE_WKG_SERVICE,
      useClass: UpdateWkgService,
    },

    // ── Pipeline step 3: entity extraction + Neo4j MERGE ───────────────────
    {
      provide: UPSERT_ENTITIES_SERVICE,
      useClass: UpsertEntitiesService,
    },

    // ── Pipeline step 4: edge derivation (RELATED_TO pairs) ─────────────────
    {
      provide: EXTRACT_EDGES_SERVICE,
      useClass: ExtractEdgesService,
    },

    // ── Pipeline step 5: Conversation nodes + MENTIONS edges ─────────────────
    {
      provide: CONVERSATION_ENTRY_SERVICE,
      useClass: ConversationEntryService,
    },

    // ── Pipeline step 6: CAN_PRODUCE edges to Word nodes ────────────────────
    {
      provide: CAN_PRODUCE_EDGES_SERVICE,
      useClass: CanProduceEdgesService,
    },

    // ── Pipeline step 7: LLM-assisted edge refinement ───────────────────────
    {
      provide: REFINE_EDGES_SERVICE,
      useClass: RefineEdgesService,
    },

    // ── Pipeline step 8: Conversation reflection (holistic session analysis) ──
    {
      provide: CONVERSATION_REFLECTION_SERVICE,
      useClass: ConversationReflectionService,
    },

    // ── Pipeline step 9: Cross-session insight synthesis ─────────────────────
    {
      provide: CROSS_SESSION_SYNTHESIS_SERVICE,
      useClass: CrossSessionSynthesisService,
    },

    // ── Event logger ─────────────────────────────────────────────────────────
    {
      provide: LEARNING_EVENT_LOGGER,
      useClass: LearningEventLoggerService,
    },
  ],
  exports: [
    // LEARNING_SERVICE is the only token exported from this module.
    // All pipeline step tokens are internal implementation details.
    LEARNING_SERVICE,
  ],
})
export class LearningModule {}
