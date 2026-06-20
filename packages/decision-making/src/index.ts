// ---------------------------------------------------------------------------
// Decision Making Module (public API)
// ---------------------------------------------------------------------------

/** The NestJS module — import this in AppModule. */
export { DecisionMakingModule } from './decision-making.module';

/**
 * InboundTurn — the queue entry type for per-turn text threading (WS4 Ticket 2).
 * Exported so CommunicationService (in apps/sylphie) can construct and enqueue
 * turns via IDecisionMakingService.enqueueTurn().
 */
export type { InboundTurn } from './concurrency/inbound-turn';

/**
 * WS4 Ticket 6 — CycleGuardService and queue-position types.
 * Exported so CommunicationService can inject CycleGuardService and subscribe
 * to queuePositionUpdates$ to relay queue-position notifications to waiting speakers.
 */
export { CycleGuardService } from './concurrency/cycle-guard.service';
export type { QueuePositionSnapshot } from './concurrency/cycle-guard.service';

/** The sole public injection token for this subsystem. */
export { DECISION_MAKING_SERVICE } from './decision-making.tokens';

/**
 * Arbitration metrics token and concrete class.
 * Exported so MetricsController can inject ArbitrationService directly to read
 * accumulated Type 1 / Type 2 / SHRUG counts for the CANON health metric.
 * The token is an alias to the module-internal ARBITRATION_SERVICE symbol.
 */
export { ARBITRATION_SERVICE } from './decision-making.tokens';
export { ArbitrationService } from './arbitration/arbitration.service';
export type { ArbitrationMetrics } from './arbitration/arbitration.service';

/**
 * Attractor monitor token and concrete class.
 * Exported so MetricsController can inject AttractorMonitorService to read the
 * rolling prediction window for PredictionMAEMetric.
 */
export { ATTRACTOR_MONITOR_SERVICE } from './decision-making.tokens';
export { AttractorMonitorService } from './monitoring/attractor-monitor.service';
export type { DetectorResult } from './monitoring/attractor-monitor.service';

/**
 * Mood-bleed monitor token and concrete class.
 * WS4 Ticket 8 — Hostile-Interlocutor Mood-Bleed Attractor Alert.
 * Exported so external consumers can inject and interrogate via getStatus().
 */
export { MOOD_BLEED_MONITOR_SERVICE } from './decision-making.tokens';
export { MoodBleedMonitorService } from './monitoring/mood-bleed-monitor.service';

/** Public interface types for consumers. */
export type { IDecisionMakingService, ITensorInferenceService, TensorInferenceResult, PanelContext } from './interfaces/decision-making.interfaces';

/** Tensor inference — externally provided by @Global() CognitionModule. */
export { TENSOR_INFERENCE_SERVICE } from './decision-making.tokens';

/** Latent space — exported for system reset. */
export { LatentSpaceService } from './latent-space/latent-space.service';
export type { LatentMatch, MultiModalLatentMatch } from './latent-space/latent-space.service';

/** Sensory prediction — exported for system reset. */
export { SensoryPredictionService } from './prediction/sensory-prediction.service';

/** Episodic memory — exported for system reset. */
export { EPISODIC_MEMORY_SERVICE } from './decision-making.tokens';
export type { IEpisodicMemoryService } from './interfaces/decision-making.interfaces';

/** Scene prediction — per-object prediction errors for attention and drive routing. */
export { ScenePredictionService, type ScenePredictionResult, type SceneObjectError, type ScenePredictionState, type SurpriseObservation, type LastScenePredictionOutcome } from './prediction/scene-prediction.service';

// ---------------------------------------------------------------------------
// Sensory Pipeline (re-exported for backward compatibility)
// ---------------------------------------------------------------------------

export { ModalityRegistryService } from './inputs/registry/modality-registry.service';
export { TextEncoder, isDocumentEncoder } from './inputs/encoders/text.encoder';
export { VideoEncoder } from './inputs/encoders/video.encoder';
export { FaceEncoder } from './inputs/encoders/face.encoder';
export { DriveEncoder } from './inputs/encoders/drive.encoder';
export { AudioEncoder, type AudioChunk } from './inputs/encoders/audio.encoder';
export { SceneEncoder } from './inputs/encoders/scene.encoder';
export { SensoryFusionService } from './inputs/fusion/sensory-fusion';
export { TickSamplerService } from './inputs/sampling/tick-sampler';

// ---------------------------------------------------------------------------
// TK-36 — deliberation pure-helper re-exports (isIgnoranceResponse,
// recallKeyForQuestion). These live in deliberation-helpers.ts but are
// re-exported here so any caller that previously imported directly from the
// service file continues to work if they ever switch to the barrel import.
// ---------------------------------------------------------------------------
export {
  isIgnoranceResponse,
  recallKeyForQuestion,
} from './deliberation/deliberation-helpers';

// ---------------------------------------------------------------------------
// WS3 Ticket T1 — pre-arbitration grounded recall retrieval
// ---------------------------------------------------------------------------
// The durable replacement for the post-hoc OKG grounding regex: a single
// pre-arbitration retrieval that surfaces the WKG/OKG fact node id grounding a
// recall answer, recorded at retrieval time and fed to both the procedure path
// and deliberate(). T2 reinforces RecallRetrieval.factNodeId; T3 decays unused.
export {
  retrieveRecallGrounding,
  applyRecallGroundingFromRetrieval,
} from './deliberation/recall-retrieval';
export type { RecallRetrieval, RecallSource } from './deliberation/recall-retrieval';

// ---------------------------------------------------------------------------
// WS5 T4 (P2/P4) — test-only "last composed prompt" mirror. Read by the gate's
// P2/P4 caption-in-prompt assertion (GET /metrics/last-deliberation-prompt).
// Dark unless GATE_DEBUG_PROMPT_CAPTURE is set (data-exfil discipline).
// ---------------------------------------------------------------------------
export {
  getLastCapturedPrompt,
  getCapturedPromptForTurn,
  resetPromptCapture,
  isPromptCaptureEnabled,
} from './deliberation/prompt-capture';
export type { CapturedPrompt, PromptCompositionPath } from './deliberation/prompt-capture';

/**
 * WS3 Ticket T2/T4 — the knowledge use→reinforce edge.
 * WkgContextService is exported (it is already a provider AND a module export of
 * DecisionMakingModule) so MetricsController can drive `reinforceFactNode()` —
 * the REAL T2 reinforcement code — from the hermetic C3 compounding gate seam.
 * The gate does NOT re-implement ACT-R math; it calls the same method the live
 * cognitive cycle calls, so a green C3 row proves the live mechanism.
 */
export { WkgContextService } from './wkg/wkg-context.service';
/**
 * Wave 3 / C4 — the guardian candidate-promotion outcome type, re-exported so
 * CommunicationService (apps/sylphie) can type the `promoteCandidate()` result it
 * forwards from the guardian_feedback channel.
 */
export type { CandidatePromotionResult } from './wkg/wkg-context.service';
