/**
 * Public API barrel for DecisionMakingModule.
 *
 * Other modules import exclusively from this barrel, never from internal file
 * paths. This enforces the module boundary: what is listed here is the
 * contract; everything else is an implementation detail.
 *
 * EXPORTED:
 *   DecisionMakingModule       — NestJS module for DI registration
 *   DECISION_MAKING_SERVICE    — Injection token for IDecisionMakingService
 *   IDecisionMakingService     — Main facade interface
 *   CategorizedInput           — Input handoff type from Communication
 *   CognitiveContext           — Cognitive state snapshot for LLM prompt assembly
 *   Episode                    — Episodic memory record type
 *   Prediction                 — Drive-effect prediction record type
 *   PredictionEvaluation       — Prediction vs. actual outcome comparison type
 *   EncodingDepth              — Episodic encoding granularity type
 *   GuardianFeedbackType       — Guardian feedback classification (DM view)
 *
 * NOT EXPORTED (internal):
 *   EPISODIC_MEMORY_SERVICE    — Internal token
 *   ARBITRATION_SERVICE        — Internal token
 *   PREDICTION_SERVICE         — Internal token
 *   ACTION_RETRIEVER_SERVICE   — Internal token
 *   CONFIDENCE_UPDATER_SERVICE — Internal token
 *   EXECUTOR_ENGINE            — Internal token
 *   IEpisodicMemoryService     — Internal interface
 *   IArbitrationService        — Internal interface
 *   IPredictionService         — Internal interface
 *   IActionRetrieverService    — Internal interface
 *   IConfidenceUpdaterService  — Internal interface
 *   IExecutorEngine            — Internal interface
 *   EpisodeInput               — Internal input type
 *   Concrete service classes   — Implementation details
 */

export { DecisionMakingModule } from './decision-making.module';

export {
  DECISION_MAKING_SERVICE,
  // All internal tokens intentionally omitted
} from './decision-making.tokens';

export type {
  IDecisionMakingService,
  CategorizedInput,
  CognitiveContext,
  Episode,
  Prediction,
  PredictionEvaluation,
  EncodingDepth,
  GuardianFeedbackType,
  // Internal interfaces and input types intentionally omitted:
  // IEpisodicMemoryService, IArbitrationService, IPredictionService,
  // IActionRetrieverService, IConfidenceUpdaterService, IExecutorEngine,
  // EpisodeInput
} from './interfaces/decision-making.interfaces';
