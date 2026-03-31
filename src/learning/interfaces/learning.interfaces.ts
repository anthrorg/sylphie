/**
 * Learning subsystem interface contracts.
 *
 * CANON §Subsystem 3 (Learning): Converts experience into durable knowledge.
 * The pipeline is: LearnableEvent → entity extraction → edge refinement →
 * contradiction detection → WKG upsert. All LLM-originated artifacts carry
 * provenance 'LLM_GENERATED' at the literal type level — this is enforced
 * structurally, not by convention.
 *
 * CANON §7 (Provenance Is Sacred): ExtractedEntity and RefinedEdge both fix
 * their provenance field as the literal type 'LLM_GENERATED'. This makes it
 * a compile-time error to pass GUARDIAN or SENSOR provenance through the
 * extraction pipeline, preventing accidental provenance laundering.
 *
 * CANON Immutable Standard 3 (Confidence Ceiling): Extracted entities and
 * refined edges begin at LLM_GENERATED base confidence (0.35). They may not
 * exceed the ceiling (0.60) until a guardian confirms them via the guardian
 * asymmetry mechanism (Standard 5).
 *
 * CANON §Subsystem 3: max 5 learnable events per maintenance cycle to prevent
 * catastrophic interference. ILearningService.runMaintenanceCycle() enforces
 * this budget internally.
 */

import type { KnowledgeNode } from '../../shared/types/knowledge.types';
import type { LearnableEvent } from '../../shared/types/event.types';
import type { ProvenanceSource } from '../../shared/types/provenance.types';

// ---------------------------------------------------------------------------
// Supporting Types
// ---------------------------------------------------------------------------

/**
 * Summary of a completed maintenance cycle.
 *
 * Produced by ILearningService.runMaintenanceCycle() and emitted as the
 * payload of the CONSOLIDATION_CYCLE_COMPLETED TimescaleDB event.
 */
export interface MaintenanceCycleResult {
  /** Number of LearnableEvents processed in this cycle (max 5 per CANON §Subsystem 3). */
  readonly eventsProcessed: number;

  /** Number of entity nodes extracted and written to (or updated in) the WKG. */
  readonly entitiesExtracted: number;

  /** Number of edges created or refined in the WKG. */
  readonly edgesRefined: number;

  /** Number of contradictions detected against existing WKG knowledge. */
  readonly contradictionsFound: number;

  /** Wall-clock duration of the full cycle in milliseconds. */
  readonly durationMs: number;
}

/**
 * An entity extracted from a LearnableEvent by the LLM-backed extraction pipeline.
 *
 * The provenance field reflects the source of the event — it may be ProvenanceSource
 * to accommodate entities from guardian events which should carry GUARDIAN provenance.
 * This is the structural enforcement of CANON §7: provenance is tracked from origin
 * through the entire learning pipeline.
 *
 * Confidence is unclamped here (validation occurs at the WKG persistence layer),
 * but callers should treat it as a raw estimate in [0.0, 1.0].
 *
 * CANON §7 (Provenance Is Sacred): Provenance source determines initial confidence
 * per CANON §Confidence Dynamics: GUARDIAN 0.60, SENSOR 0.40, LLM_GENERATED 0.35,
 * INFERENCE 0.30. The confidence ceiling (0.60) is enforced at WKG persistence.
 */
export interface ExtractedEntity {
  /** Human-readable name of the entity (e.g., 'Jim', 'Neo4j', 'red mug'). */
  readonly name: string;

  /**
   * Neo4j label string for this entity (e.g., 'Person', 'Technology', 'Object').
   * Becomes the node label in the WKG. By convention, PascalCase.
   */
  readonly type: string;

  /** Domain-specific properties extracted from the event content. */
  readonly properties: Record<string, unknown>;

  /**
   * Provenance source indicating the origin of this entity.
   *
   * CANON §7: Reflects the source of the learnable event. Entities from
   * guardian-sourced events carry GUARDIAN provenance; those from LLM processing
   * carry LLM_GENERATED. This is never stripped or upgraded accidentally.
   */
  readonly provenance: ProvenanceSource;

  /**
   * How this entity was matched or created.
   *
   * - 'EXACT_MATCH': Merged with existing WKG node by name.
   * - 'FUZZY_MATCH': Merged with similar existing node (string distance).
   * - 'AMBIGUOUS': Multiple potential matches; flagged for review.
   * - 'NEW': Created as a new WKG node.
   */
  readonly resolution: EntityResolution;

  /**
   * Initial confidence estimate from the extraction model. Will be clamped
   * to CONFIDENCE_THRESHOLDS.ceiling (0.60) by the WKG persistence layer.
   * CANON Standard 3: Base confidence depends on provenance source.
   */
  readonly confidence: number;

  /** The TimescaleDB event ID that produced this entity (for causal traceability). */
  readonly sourceEventId: string;
}

/**
 * Entity resolution type indicating how an extracted entity was handled.
 *
 * CANON §Learning: Entities may be exact matches, fuzzy matches, ambiguous,
 * or entirely new. The resolution type informs downstream confidence adjustments.
 */
export type EntityResolution = 'EXACT_MATCH' | 'FUZZY_MATCH' | 'AMBIGUOUS' | 'NEW';

/**
 * A refined edge produced by IEdgeRefinementService.
 *
 * Like ExtractedEntity, provenance is locked to 'LLM_GENERATED'. Edges
 * originating from LLM reasoning cannot be passed off as GUARDIAN or SENSOR
 * knowledge. The WKG persistence layer enforces the confidence ceiling.
 *
 * refinedBy: The name of the refinement strategy or model that produced this
 * edge (e.g., 'relationship-extraction-v1'). Carries attribution for the
 * diagnostic Lesion Test (CANON §7).
 */
export interface RefinedEdge {
  /** Name of the source entity node (must match an ExtractedEntity or existing WKG node). */
  readonly sourceEntityName: string;

  /** Name of the target entity node. */
  readonly targetEntityName: string;

  /**
   * Neo4j relationship type string.
   * UPPER_SNAKE_CASE by convention. E.g., 'KNOWS', 'LOCATED_IN', 'IS_A'.
   */
  readonly relationship: string;

  /**
   * Literal provenance type. Always 'LLM_GENERATED' for refinement output.
   *
   * CANON §7: Same structural enforcement as ExtractedEntity.provenance.
   * Edges from the LLM-based refinement pipeline are always LLM_GENERATED.
   */
  readonly provenance: 'LLM_GENERATED';

  /**
   * Confidence estimate for this relationship in [0.0, 1.0].
   * Clamped to ceiling at persistence time.
   */
  readonly confidence: number;

  /** The strategy or model that produced this refinement (for attribution and diagnostics). */
  readonly refinedBy: string;
}

/**
 * Result of a contradiction check between incoming extracted knowledge and
 * existing WKG knowledge.
 *
 * Discriminated union — callers switch on `type`. The 'no_conflict' branch
 * is the fast path; the 'contradiction' branch triggers event emission and
 * guardian routing per CANON §Learning.
 *
 * resolution options:
 *   GUARDIAN_REVIEW: Flag for human review; neither party wins automatically.
 *   SUPERSEDED:      The incoming knowledge replaces the existing (high-confidence
 *                    incoming from a trusted source, e.g., guardian teaching).
 *   COEXIST:         Both are retained with reduced confidence, pending resolution.
 */
export type ContradictionCheckResult =
  | {
      /** No conflict detected — the incoming entity is consistent with existing knowledge. */
      readonly type: 'no_conflict';
    }
  | {
      /** A conflict exists between incoming and existing knowledge. */
      readonly type: 'contradiction';

      /** The node currently in the WKG that conflicts with the incoming entity. */
      readonly existing: KnowledgeNode;

      /** The entity from the extraction pipeline that conflicts with existing. */
      readonly incoming: ExtractedEntity;

      /**
       * A string describing the nature of the conflict.
       * E.g., 'TYPE_MISMATCH', 'PROPERTY_CONFLICT', 'RELATIONSHIP_NEGATION'.
       */
      readonly conflictType: string;

      /**
       * Recommended resolution strategy.
       *
       * GUARDIAN_REVIEW: Default for most LLM-origin conflicts. Guardian decides.
       * SUPERSEDED:      Use when incoming provenance is higher-authority.
       * COEXIST:         Use when conflict is ambiguous or context-dependent.
       */
      readonly resolution: 'GUARDIAN_REVIEW' | 'SUPERSEDED' | 'COEXIST';
    };

// ---------------------------------------------------------------------------
// Service Interfaces
// ---------------------------------------------------------------------------

/**
 * Main orchestrator for the Learning subsystem.
 *
 * Coordinates the full consolidation pipeline: querying for learnable events,
 * running extraction, refinement, and contradiction detection, then writing
 * results to the WKG. Emits CONSOLIDATION_CYCLE_STARTED and
 * CONSOLIDATION_CYCLE_COMPLETED TimescaleDB events.
 *
 * CANON §Subsystem 3: The cycle is triggered by the Decision Making subsystem
 * when Cognitive Awareness drive pressure exceeds threshold. The Learning module
 * does not self-trigger.
 */
export interface ILearningService {
  /**
   * Execute a full maintenance and consolidation cycle.
   *
   * Fetches up to 5 LearnableEvents (max per CANON §Subsystem 3), runs the
   * entity extraction → edge refinement → contradiction detection pipeline
   * for each, and writes all non-contradicting results to the WKG.
   * Contradictions are flagged for guardian review.
   *
   * Emits CONSOLIDATION_CYCLE_STARTED before processing and
   * CONSOLIDATION_CYCLE_COMPLETED on completion.
   *
   * @returns Summary of what was processed, extracted, refined, and flagged.
   * @throws LearningException if the cycle cannot start (e.g., Events service unavailable).
   */
  runMaintenanceCycle(): Promise<MaintenanceCycleResult>;

  /**
   * Check whether the Cognitive Awareness drive pressure currently exceeds the
   * consolidation threshold, indicating a cycle should run.
   *
   * This is a pure synchronous check against the last received DriveSnapshot.
   * It does not fetch a new snapshot.
   *
   * @returns True if Cognitive Awareness drive pressure exceeds the threshold.
   */
  shouldConsolidate(): boolean;

  /**
   * Return the timestamp of the last completed maintenance cycle, or null if
   * no cycle has run since service initialization.
   *
   * Used by Decision Making to avoid triggering redundant cycles in rapid
   * succession.
   *
   * @returns Timestamp of last cycle completion, or null.
   */
  getLastCycleTimestamp(): Date | null;

  /**
   * Return the total number of maintenance cycles completed since service
   * initialization.
   *
   * Used for diagnostics and metrics logging.
   *
   * @returns Count of completed cycles (0 on cold start).
   */
  getCycleCount(): number;
}

/**
 * Extracts named entities from a single LearnableEvent using the LLM.
 *
 * This is always a Type 2 operation: every call goes to the LLM. There is no
 * Type 1 path for entity extraction in Phase 1. The LLM cost must be reported
 * to the Events module on every call (CANON §Type 2 Cost Requirement).
 *
 * All returned entities carry provenance: 'LLM_GENERATED'. This is not
 * configurable — it is the structural enforcement of CANON §7.
 */
export interface IEntityExtractionService {
  /**
   * Extract named entities from the content of a LearnableEvent.
   *
   * Each returned ExtractedEntity carries provenance: 'LLM_GENERATED' at the
   * literal type level. The extraction model assigns an initial confidence
   * estimate; the WKG persistence layer applies the ceiling.
   *
   * An empty array is a valid result — it means the event contained no
   * extractable entity content.
   *
   * @param event - The learnable event whose content should be processed.
   * @returns Array of extracted entities (may be empty). Never null.
   * @throws LearningException if the LLM call fails and no fallback is available.
   */
  extract(event: LearnableEvent): Promise<ExtractedEntity[]>;
}

/**
 * Refines edges between entities using the LLM, given a set of extracted
 * entities and the originating event for context.
 *
 * Like entity extraction, this is always Type 2. All returned edges carry
 * provenance: 'LLM_GENERATED' at the literal type level.
 *
 * CANON §Learning: CAN_PRODUCE edges created during Learning consolidation
 * record which phrases Sylphie produced — these carry LLM_GENERATED provenance
 * and are a primary output of this service.
 */
export interface IEdgeRefinementService {
  /**
   * Derive and refine edges between the provided entities, using the originating
   * event as contextual grounding.
   *
   * Returns edges connecting entities within the provided set and optionally
   * edges connecting them to existing WKG nodes (identified by name lookup).
   * All returned edges carry provenance: 'LLM_GENERATED'.
   *
   * An empty array is valid — not all entity sets have identifiable relationships.
   *
   * @param entities - The entities extracted from the event (may be empty).
   * @param context  - The originating LearnableEvent, used to ground the LLM call.
   * @returns Array of refined edges (may be empty). Never null.
   * @throws LearningException if the LLM call fails and no fallback is available.
   */
  refine(
    entities: readonly ExtractedEntity[],
    context: LearnableEvent,
  ): Promise<RefinedEdge[]>;
}

/**
 * Checks an incoming extracted entity against existing WKG knowledge to detect
 * contradictions before the entity is written to the graph.
 *
 * Contradiction detection is a discriminated union return, never an exception
 * (CANON §Knowledge: contradictions are developmental catalysts, not errors).
 * When a contradiction is found, the caller is responsible for emitting a
 * CONTRADICTION_DETECTED TimescaleDB event.
 */
export interface IContradictionDetector {
  /**
   * Compare an incoming extracted entity against an existing WKG node (if any)
   * to determine whether a contradiction exists.
   *
   * If existing is null, returns { type: 'no_conflict' } immediately — there is
   * nothing to contradict.
   *
   * If a contradiction is detected, the result includes both parties and a
   * recommended resolution strategy. The caller decides how to proceed; this
   * service does not write to the WKG or emit events.
   *
   * @param incoming - The entity just extracted from a LearnableEvent.
   * @param existing - The WKG node with the same label/type, or null if none exists.
   * @returns Discriminated union: no_conflict or contradiction with resolution guidance.
   * @throws LearningException if the comparison itself fails (e.g., WKG query error).
   */
  check(
    incoming: ExtractedEntity,
    existing: KnowledgeNode | null,
  ): Promise<ContradictionCheckResult>;
}

// ---------------------------------------------------------------------------
// Additional Supporting Types
// ---------------------------------------------------------------------------

/**
 * A refined edge produced by IEdgeRefinementService, expanded with metadata.
 *
 * CANON §Learning: Edges carry relationship semantics and provenance. The eight
 * relationship types (HAS_PROPERTY, IS_A, CAN_PRODUCE, RESPONSE_TO, FOLLOWS_PATTERN,
 * TRIGGERS, SUPERSEDES, CORRECTED_BY) form the semantic skeleton of the WKG.
 *
 * Like ExtractedEntity, provenance is ProvenanceSource to accommodate edges from
 * various origins. The confidence ceiling (0.60) is enforced at WKG persistence.
 */
export interface ExtractedEdge {
  /** Name of the source entity node (must match an ExtractedEntity or existing WKG node). */
  readonly sourceEntityName: string;

  /** Name of the target entity node. */
  readonly targetEntityName: string;

  /**
   * Neo4j relationship type string. One of: HAS_PROPERTY, IS_A, CAN_PRODUCE,
   * RESPONSE_TO, FOLLOWS_PATTERN, TRIGGERS, SUPERSEDES, CORRECTED_BY.
   * UPPER_SNAKE_CASE by convention.
   *
   * CANON §Learning: These eight types form the semantic backbone of the WKG.
   */
  readonly relationship: string;

  /**
   * Provenance source indicating the origin of this edge.
   *
   * CANON §7: Reflects whether the edge came from LLM reasoning, guardian teaching,
   * or system inference. Never stripped or upgraded accidentally.
   */
  readonly provenance: ProvenanceSource;

  /**
   * Confidence estimate for this relationship in [0.0, 1.0].
   * Clamped to ceiling at persistence time.
   * CANON Standard 3: Base confidence depends on provenance source.
   */
  readonly confidence: number;

  /** The strategy or model that produced this refinement (for attribution and diagnostics). */
  readonly refinedBy: string;

  /** Optional domain-specific metadata attached to this edge (e.g., weights, context). */
  readonly metadata?: Record<string, unknown>;

  /** The TimescaleDB event ID that sourced this edge (for causal traceability). */
  readonly sourceEventId: string;
}

/**
 * Detailed contradiction detected between incoming and existing knowledge.
 *
 * CANON §Learning: Contradictions are developmental catalysts, not errors.
 * Each contradiction includes sufficient context for a guardian to make a
 * conscious resolution choice: prefer existing, prefer incoming, or merge.
 */
export interface Contradiction {
  /** Unique identifier for this contradiction record. */
  readonly id: string;

  /** The category of contradiction detected. */
  readonly type: ContradictionType;

  /** The ID of the existing WKG node that conflicts with the incoming entity. */
  readonly existingNodeId: string;

  /** The incoming entity that triggered the contradiction. */
  readonly incomingEntity: ExtractedEntity;

  /** Human-readable description of the conflict (e.g., 'TYPE_MISMATCH', 'PROPERTY_CONFLICT'). */
  readonly conflictDetails: string;

  /** Recommended resolution strategy based on provenance and confidence analysis. */
  readonly resolution: ContradictionResolution;

  /** Confidence gap between existing and incoming (incoming.confidence - existing.confidence). */
  readonly confidenceGap: number;

  /** Timestamp when this contradiction was resolved, or null if still pending. */
  readonly resolvedAt: Date | null;
}

/**
 * Category of contradiction detected.
 *
 * CANON §Learning: Used to route contradictions to appropriate resolution strategies.
 * - 'DIRECT': Direct conflict (e.g., "Jim is 30" vs "Jim is 31").
 * - 'CONFIDENCE': Confidence level conflict without semantic disagreement.
 * - 'SCHEMA': Type or structural mismatch (e.g., entity labeled as Person vs Technology).
 * - 'TEMPORAL': Time-dependent conflict (e.g., historical vs current state).
 */
export type ContradictionType = 'DIRECT' | 'CONFIDENCE' | 'SCHEMA' | 'TEMPORAL';

/**
 * Resolution strategy for a contradiction.
 *
 * CANON §Learning: Directed by provenance and confidence, subject to guardian override.
 * - 'PREFER_GUARDIAN': Guardian-origin knowledge wins.
 * - 'MERGE': Both versions retained with reduced confidence, pending resolution.
 * - 'FLAG_AMBIGUOUS': Flag for human review; neither party wins automatically.
 */
export type ContradictionResolution = 'PREFER_GUARDIAN' | 'MERGE' | 'FLAG_AMBIGUOUS';

/**
 * Result from a single learning job execution.
 *
 * CANON §Subsystem 3: Each consolidation cycle consists of multiple jobs
 * (entity extraction, edge refinement, contradiction detection, WKG upsert).
 * This type records the outcome of one job.
 */
export interface JobResult {
  /** The human-readable name of the job (e.g., 'entity-extraction', 'edge-refinement'). */
  readonly jobName: string;

  /** Whether the job completed successfully. */
  readonly success: boolean;

  /** Count of artifacts produced (nodes/edges created or updated). */
  readonly artifactCount: number;

  /** List of issues encountered (warnings, partial failures) — may be empty. */
  readonly issues: readonly string[];

  /** Wall-clock latency of job execution in milliseconds. */
  readonly latencyMs: number;

  /** Error message if the job failed, or undefined if success is true. */
  readonly error?: string;
}

/**
 * Full metrics for a completed maintenance/consolidation cycle.
 *
 * CANON §Subsystem 3: Emitted as the payload of CONSOLIDATION_CYCLE_COMPLETED.
 * Provides visibility into learning load, throughput, and health.
 */
export interface LearningCycleMetrics {
  /** Wall-clock duration of the full consolidation cycle in milliseconds. */
  readonly cycleDurationMs: number;

  /** Number of LearnableEvents processed in this cycle (max 5 per CANON). */
  readonly eventsProcessed: number;

  /** Number of entities extracted. */
  readonly entitiesExtracted: number;

  /** Number of edges refined. */
  readonly edgesRefined: number;

  /** Number of contradictions detected. */
  readonly contradictionsFound: number;

  /** Total number of jobs executed in this cycle. */
  readonly jobsExecuted: number;

  /** Number of jobs that failed or partially failed. */
  readonly jobsFailed: number;
}

/**
 * Health assessment of the WKG by provenance distribution.
 *
 * CANON §7 (Provenance Is Sacred): A healthy KG has a high ratio of experiential
 * knowledge (SENSOR, GUARDIAN) vs. speculative knowledge (LLM_GENERATED, INFERENCE).
 * This type quantifies that ratio for diagnostics.
 */
export interface ProvenanceHealth {
  /** Ratio of SENSOR nodes to total nodes. */
  readonly sensorRatio: number;

  /** Ratio of GUARDIAN nodes to total nodes. */
  readonly guardianRatio: number;

  /** Ratio of LLM_GENERATED nodes to total nodes. */
  readonly llmRatio: number;

  /** Ratio of INFERENCE nodes to total nodes. */
  readonly inferenceRatio: number;

  /**
   * Combined health assessment.
   * - 'HEALTHY': Experiential ratio > 0.60.
   * - 'DEVELOPING': Experiential ratio in [0.40, 0.60].
   * - 'UNHEALTHY': Experiential ratio < 0.40.
   */
  readonly healthStatus: 'HEALTHY' | 'DEVELOPING' | 'UNHEALTHY';

  /** Total number of nodes in the WKG. */
  readonly totalNodes: number;

  /** Total number of edges in the WKG. */
  readonly totalEdges: number;
}

/**
 * Salience score assigned to a LearnableEvent for prioritization.
 *
 * CANON §Subsystem 3: The consolidation cycle processes max 5 events per cycle.
 * When more events are available, the highest-salience events are selected.
 * Salience combines recency, guardian feedback, and drive state.
 */
export interface SalienceScore {
  /** The ID of the LearnableEvent being scored. */
  readonly eventId: string;

  /** Base salience before recency adjustment. */
  readonly baseSalience: number;

  /** Recency boost applied to favor recent events. */
  readonly recencyBoost: number;

  /** Total score: baseSalience + recencyBoost. Used for ranking. */
  readonly totalScore: number;
}

/**
 * Result of a full consolidation cycle including entity extraction, edge refinement,
 * contradiction detection, and WKG upsert.
 *
 * CANON §Subsystem 3: Emitted as the payload of CONSOLIDATION_CYCLE_COMPLETED.
 */
export interface ConsolidationResult {
  /** Entities extracted from the processed events. */
  readonly entityExtractionResults: readonly ExtractedEntity[];

  /** Edges refined from the extracted entities. */
  readonly edgeRefinementResults: readonly ExtractedEdge[];

  /** Contradictions detected against existing WKG knowledge. */
  readonly contradictions: readonly Contradiction[];

  /** Results from each job executed during the cycle. */
  readonly jobResults: readonly JobResult[];

  /** Comprehensive metrics for the cycle. */
  readonly cycleMetrics: LearningCycleMetrics;

  /** Number of events included in this consolidation. */
  readonly batchSize: number;
}

/**
 * Salience-ranked batch of events selected for consolidation.
 *
 * CANON §Subsystem 3: The Learning subsystem selects up to 5 events per cycle.
 * This type represents the selected batch with ranking data for diagnostics.
 */
export interface ConsolidationBatch {
  /** The LearnableEvents selected for this consolidation cycle. */
  readonly events: readonly LearnableEvent[];

  /** Salience scores for each event (parallel array to events). */
  readonly salienceScores: readonly SalienceScore[];

  /** The actual batch size (number of events selected, max 5). */
  readonly batchSize: number;

  /** Timestamp when this batch was assembled. */
  readonly selectedAt: Date;
}

// ---------------------------------------------------------------------------
// Extended Service Interfaces
// ---------------------------------------------------------------------------

/**
 * Job interface for learnable task execution.
 *
 * CANON §Subsystem 3: The consolidation cycle is composed of learnable jobs.
 * Each job is executed in sequence and its result is tracked.
 */
export interface ILearningJob {
  /**
   * The human-readable name of this job.
   *
   * @returns Job name (e.g., 'entity-extraction')
   */
  readonly name: string;

  /**
   * Determine whether this job should run in the current consolidation cycle.
   *
   * @returns True if the job should execute; false to skip.
   */
  shouldRun(): boolean;

  /**
   * Execute the job and return its result.
   *
   * @returns Result of job execution with artifact count, issues, and latency.
   * @throws Error if the job fails catastrophically.
   */
  run(): Promise<JobResult>;
}

/**
 * Consolidation service — orchestrates batch selection and full consolidation.
 *
 * CANON §Subsystem 3: Coordinates the entity extraction → edge refinement →
 * contradiction detection → WKG upsert pipeline for a batch of events.
 */
export interface IConsolidationService {
  /**
   * Select a salience-ranked batch of learnable events for consolidation.
   *
   * CANON §Subsystem 3: Selects up to `limit` events, ranked by salience.
   * Defaults to 5 per CANON specification.
   *
   * @param limit - Maximum number of events to select (default 5).
   * @returns Batch of selected events with salience scores.
   * @throws LearningException if event query fails.
   */
  selectBatch(limit?: number): Promise<ConsolidationBatch>;

  /**
   * Execute the full consolidation pipeline for a batch.
   *
   * Runs entity extraction → edge refinement → contradiction detection → WKG upsert.
   * Contradictions are flagged but do not cause the cycle to fail.
   *
   * @param batch - The batch to consolidate.
   * @returns Full consolidation result with metrics.
   * @throws LearningException if the pipeline fails.
   */
  consolidate(batch: ConsolidationBatch): Promise<ConsolidationResult>;
}

/**
 * Event ranking service — assigns salience scores for prioritization.
 *
 * CANON §Subsystem 3: Salience combines recency, guardian feedback presence,
 * and drive state to prioritize high-value learning events.
 */
export interface IEventRankerService {
  /**
   * Rank a set of LearnableEvents by salience.
   *
   * Returns parallel array of SalienceScore objects with the same length as input.
   * Higher scores indicate higher priority for consolidation.
   *
   * @param events - Events to rank.
   * @returns Array of salience scores parallel to events.
   */
  rankBySalience(events: readonly LearnableEvent[]): SalienceScore[];
}

/**
 * Main cycle orchestrator — higher-level interface over ILearningService.
 *
 * CANON §Subsystem 3: The maintenance cycle is triggered by Decision Making
 * when Cognitive Awareness drive pressure exceeds threshold. This service
 * encapsulates the full cycle state machine.
 */
export interface IMaintenanceCycleService {
  /**
   * Execute a full maintenance and consolidation cycle.
   *
   * Selects events, runs consolidation, emits CONSOLIDATION_CYCLE_STARTED and
   * CONSOLIDATION_CYCLE_COMPLETED events.
   *
   * @returns Comprehensive metrics from the completed cycle.
   * @throws LearningException if the cycle fails.
   */
  executeCycle(): Promise<LearningCycleMetrics>;

  /**
   * Check whether a cycle is currently running.
   *
   * Used to prevent concurrent cycle execution.
   *
   * @returns True if a cycle is in progress.
   */
  isRunning(): boolean;

  /**
   * Return the timestamp of the last completed cycle, or null if none.
   *
   * Used by Decision Making to avoid rapid re-triggering.
   *
   * @returns Timestamp of last completion, or null.
   */
  getLastCycleTime(): Date | null;
}
