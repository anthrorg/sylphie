/**
 * NestJS injection tokens for the DecisionMakingModule.
 *
 * Symbols are used so that the DI container can bind interfaces (not
 * concrete classes) at injection sites. Consumers import only the token
 * they need; they never reference concrete service classes directly.
 *
 * EXPORTED tokens (public API — re-exported from index.ts):
 *   DECISION_MAKING_SERVICE    — IDecisionMakingService, main facade
 *
 * INTERNAL tokens (NOT exported from index.ts):
 *   EPISODIC_MEMORY_SERVICE      — IEpisodicMemoryService, in-process episode store
 *   CONSOLIDATION_SERVICE        — IConsolidationService, episodic consolidation
 *   ARBITRATION_SERVICE          — IArbitrationService, Type 1/2/SHRUG arbitration
 *   PREDICTION_SERVICE           — IPredictionService, drive-effect prediction
 *   ACTION_RETRIEVER_SERVICE     — IActionRetrieverService, WKG candidate retrieval
 *   CONFIDENCE_UPDATER_SERVICE   — IConfidenceUpdaterService, ACT-R confidence updates
 *   EXECUTOR_ENGINE              — IExecutorEngine, cognitive loop state machine
 *   THRESHOLD_COMPUTATION_SERVICE — IThresholdComputationService, dynamic threshold
 *   CONTRADICTION_SCANNER        — IContradictionScannerService, pre-commit coherence check
 *
 * Internal tokens are wired inside DecisionMakingModule only. No other module
 * should ever inject them. They are deliberately absent from the barrel export.
 */

/**
 * Injection token for IDecisionMakingService.
 * The sole public API token for the Decision Making subsystem.
 * Re-exported from index.ts.
 */
export const DECISION_MAKING_SERVICE = Symbol('DECISION_MAKING_SERVICE');

/**
 * Injection token for IEpisodicMemoryService.
 * INTERNAL TO DecisionMakingModule ONLY. Not exported from index.ts.
 */
export const EPISODIC_MEMORY_SERVICE = Symbol('EPISODIC_MEMORY_SERVICE');

/**
 * Injection token for IConsolidationService.
 * INTERNAL TO DecisionMakingModule ONLY. Not exported from index.ts.
 */
export const CONSOLIDATION_SERVICE = Symbol('CONSOLIDATION_SERVICE');

/**
 * Injection token for IArbitrationService.
 * INTERNAL TO DecisionMakingModule ONLY. Not exported from index.ts.
 */
export const ARBITRATION_SERVICE = Symbol('ARBITRATION_SERVICE');

/**
 * Injection token for IPredictionService.
 * INTERNAL TO DecisionMakingModule ONLY. Not exported from index.ts.
 */
export const PREDICTION_SERVICE = Symbol('PREDICTION_SERVICE');

/**
 * Injection token for IActionRetrieverService.
 * INTERNAL TO DecisionMakingModule ONLY. Not exported from index.ts.
 */
export const ACTION_RETRIEVER_SERVICE = Symbol('ACTION_RETRIEVER_SERVICE');

/**
 * Injection token for IConfidenceUpdaterService.
 * INTERNAL TO DecisionMakingModule ONLY. Not exported from index.ts.
 */
export const CONFIDENCE_UPDATER_SERVICE = Symbol('CONFIDENCE_UPDATER_SERVICE');

/**
 * Injection token for IExecutorEngine.
 * INTERNAL TO DecisionMakingModule ONLY. Not exported from index.ts.
 */
export const EXECUTOR_ENGINE = Symbol('EXECUTOR_ENGINE');

/**
 * Injection token for IThresholdComputationService.
 * INTERNAL TO DecisionMakingModule ONLY. Not exported from index.ts.
 *
 * Used by IArbitrationService to compute dynamic action thresholds based on
 * current drive state. Pure computation — no side effects.
 */
export const THRESHOLD_COMPUTATION_SERVICE = Symbol('THRESHOLD_COMPUTATION_SERVICE');

/**
 * Injection token for ActionHandlerRegistry.
 * INTERNAL TO DecisionMakingModule ONLY. Not exported from index.ts.
 *
 * Used by ExecutorEngine to dispatch action steps during the EXECUTING state.
 * Maps action step types to handler implementations.
 */
export const ACTION_HANDLER_REGISTRY = Symbol('ACTION_HANDLER_REGISTRY');

/**
 * Injection token for ProcessInputService.
 * INTERNAL TO DecisionMakingModule ONLY. Not exported from index.ts.
 *
 * Bridges SensoryFrame input into the FSM's CATEGORIZING state. Categorizes
 * input modalities, generates context fingerprints from fused embeddings,
 * and retrieves action candidates.
 */
export const PROCESS_INPUT_SERVICE = Symbol('PROCESS_INPUT_SERVICE');

/**
 * Injection token for DecisionEventLoggerService.
 * INTERNAL TO DecisionMakingModule ONLY. Not exported from index.ts.
 *
 * Provides unified event logging to TimescaleDB for all decision-making steps.
 * Buffers events and flushes every 10 events or 100ms for efficiency.
 */
export const DECISION_EVENT_LOGGER = Symbol('DECISION_EVENT_LOGGER');

/**
 * Injection token for IShruggableActionService.
 * INTERNAL TO DecisionMakingModule ONLY. Not exported from index.ts.
 *
 * Enforces CANON Immutable Standard 4 (Shrug Imperative): When nothing is
 * above threshold, signal incomprehension. No random low-confidence actions.
 *
 * Used by IArbitrationService to detect universal candidate insufficiency
 * and create proper shrug actions with full provenance and event logging.
 */
export const SHRUGGABLE_ACTION_SERVICE = Symbol('SHRUGGABLE_ACTION_SERVICE');

/**
 * Injection token for IType1TrackerService.
 * INTERNAL TO DecisionMakingModule ONLY. Not exported from index.ts.
 *
 * Tracks the lifecycle of actions through Type 1 / Type 2 state machine.
 * Manages graduation (Type 2 -> Type 1 reflex) and demotion (Type 1 -> Type 2)
 * based on confidence and prediction accuracy thresholds.
 *
 * Used by IArbitrationService and IConfidenceUpdaterService to evaluate
 * whether an action qualifies for fast (Type 1) execution or requires
 * LLM-assisted (Type 2) deliberation.
 */
export const TYPE_1_TRACKER_SERVICE = Symbol('TYPE_1_TRACKER_SERVICE');

/**
 * Injection token for AttractorMonitorService.
 * INTERNAL TO DecisionMakingModule ONLY. Not exported from index.ts.
 *
 * Monitors for attractor states (CANON §Known Attractor States):
 *   1. TYPE_2_ADDICT — LLM always wins, Type 1 never develops
 *   2. HALLUCINATED_KNOWLEDGE — >20% nodes without SENSOR/GUARDIAN provenance
 *   3. DEPRESSIVE_ATTRACTOR — >80% negative self-evaluations
 *   4. PLANNING_RUNAWAY — >70% prediction failures with plan proliferation
 *   5. PREDICTION_PESSIMIST — Early learning phase with MAE > 0.30
 *
 * Detectors run every decision cycle and alert when thresholds are exceeded.
 * Used by IDecisionMakingService to surface system health issues.
 */
export const ATTRACTOR_MONITOR_SERVICE = Symbol('ATTRACTOR_MONITOR_SERVICE');

/**
 * Injection token for IContradictionScannerService.
 * INTERNAL TO DecisionMakingModule ONLY. Not exported from index.ts.
 *
 * Pre-commit coherence check inspired by co-being's Validation Phase.
 * Before committing a TYPE_1 or TYPE_2 arbitration result, scans the WKG
 * for CONTRADICTS edges related to the candidate's activated knowledge.
 * If contradictions are found, the result may be downgraded to SHRUG
 * with GapType.CONTRADICTION.
 */
export const CONTRADICTION_SCANNER = Symbol('CONTRADICTION_SCANNER');
