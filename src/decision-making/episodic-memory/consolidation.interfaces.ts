/**
 * Episodic Memory Consolidation Interfaces (E5-T004)
 *
 * When episodes mature (age > 2h, confidence > 0.65), they are consolidated into
 * the World Knowledge Graph as semantic content. This bridges raw event storage to
 * durable knowledge.
 *
 * CANON §Subsystem 1 (Decision Making): Episodic memory is distinct from the WKG.
 * The Learning subsystem is responsible for promoting episode content into WKG
 * nodes. The consolidation service identifies candidates and extracts semantic
 * content; the Learning subsystem performs the actual WKG write.
 *
 * CANON §Provenance: Every consolidated semantic conversion preserves provenance
 * from the source episode's context. This enables the Lesion Test to trace which
 * episodes contributed to which knowledge.
 */

import type { Episode } from '../interfaces/decision-making.interfaces';
import type { ProvenanceSource } from '../../shared/types/provenance.types';

// ---------------------------------------------------------------------------
// Consolidation Candidate
// ---------------------------------------------------------------------------

/**
 * An episode that has reached maturity and is ready for consolidation.
 *
 * Episodes graduate to consolidation status when:
 *   - Age > 2 hours (sufficient time for initial encoding to settle)
 *   - Estimated confidence > 0.65 (above the reliability threshold)
 *
 * The consolidation service identifies candidates and passes them to the
 * conversion step.
 */
export interface ConsolidationCandidate {
  /** The episode ready for consolidation. */
  readonly episode: Episode;

  /** Age of the episode in hours since encoding. */
  readonly ageHours: number;

  /**
   * Estimated confidence in the episode's semantic value [0.0, 1.0].
   * Derived from ageWeight and encoding depth:
   *   DEEP:   min(1.0, ageWeight * 1.2)
   *   NORMAL: ageWeight
   *   SHALLOW: max(0.4, ageWeight * 0.8)
   *
   * Only episodes with estimatedConfidence > 0.65 are consolidated.
   */
  readonly estimatedConfidence: number;
}

// ---------------------------------------------------------------------------
// Semantic Relationship
// ---------------------------------------------------------------------------

/**
 * A semantic relationship extracted from episode context.
 *
 * Relationships are subject-predicate-object triples used to populate
 * WKG edges. Each relationship carries its own confidence derived from
 * the episode's encoding depth and drive state at consolidation time.
 */
export interface SemanticRelationship {
  /** The subject entity of the relationship (e.g., "user", "action-name"). */
  readonly subject: string;

  /** The relationship type/predicate (e.g., "triggered-by", "led-to"). */
  readonly predicate: string;

  /** The object entity of the relationship. */
  readonly object: string;

  /** Confidence in this relationship [0.0, 1.0]. */
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// Semantic Conversion
// ---------------------------------------------------------------------------

/**
 * The result of converting an episode into semantic WKG content.
 *
 * A consolidation extracts:
 *   - Entities: noun phrases and named entities from inputSummary
 *   - Relationships: contextual links derived from action context
 *   - Provenance: the source of the semantic content
 *   - Confidence: overall trust in the extracted semantics
 *
 * The conversion does not write to the WKG; it prepares the semantic
 * content for handoff to the Learning subsystem. The Learning subsystem
 * decides whether and how to persist the conversion.
 */
export interface SemanticConversion {
  /** UUID of the source episode. Links the conversion back to its experience. */
  readonly sourceEpisodeId: string;

  /**
   * Extracted entities (noun phrases, named concepts).
   * Simple tokenization: nouns, noun phrases, proper nouns from inputSummary.
   * May include both concrete entities (e.g., "the sofa") and abstract concepts
   * (e.g., "discomfort", "curiosity").
   */
  readonly entities: readonly string[];

  /**
   * Semantic relationships derived from the episode's action context.
   * Relationships connect entities and express causal, temporal, or
   * associative links (e.g., "input → action", "action → predicted-relief").
   */
  readonly relationships: readonly SemanticRelationship[];

  /**
   * The provenance source of this semantic conversion.
   *
   * The provenance is inherited from the episode's drive context:
   *   - If driveSnapshot.feedbackType === 'confirmation': GUARDIAN
   *   - If driveSnapshot.feedbackType === 'correction': GUARDIAN
   *   - If driveSnapshot.feedbackType === 'none': INFERENCE
   *
   * This ensures that guardian-confirmed episodes elevate their provenance
   * when consolidated (CANON Standard 5 — Guardian Asymmetry).
   */
  readonly provenance: ProvenanceSource;

  /**
   * Overall confidence in this semantic conversion [0.0, 1.0].
   * Used by the Learning subsystem to weight the value of the conversion
   * when deciding persistence and edge confidence.
   */
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// Consolidation Result
// ---------------------------------------------------------------------------

/**
 * The outcome of a single consolidation operation.
 *
 * Returned by consolidate() to report whether the consolidation succeeded,
 * how many semantic conversions were created, and any error details if
 * consolidation failed.
 *
 * Consolidation failures do not drop the episode; they are logged and
 * the episode remains in episodic memory for later retry.
 */
export interface ConsolidationResult {
  /** UUID of the source episode. */
  readonly episodeId: string;

  /** Whether the consolidation succeeded. */
  readonly success: boolean;

  /** Number of semantic conversions created by this consolidation. */
  readonly conversionsCreated: number;

  /**
   * Error message if consolidation failed.
   * Omitted if success === true.
   */
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// IConsolidationService
// ---------------------------------------------------------------------------

/**
 * Interface for episodic memory consolidation (E5-T004).
 *
 * Consolidation identifies mature episodes and extracts semantic content
 * for promotion to the World Knowledge Graph. The conversion does not
 * write to the WKG; it prepares data for the Learning subsystem.
 *
 * CANON §Subsystem 1 (Decision Making): Episodic memory consolidation is
 * the bridge between in-memory episode storage and durable WKG knowledge.
 *
 * Injection token: CONSOLIDATION_SERVICE (decision-making.tokens.ts)
 * Provided by:    ConsolidationService
 */
export interface IConsolidationService {
  /**
   * Identify all episodes in episodic memory that are ready for consolidation.
   *
   * Consolidation candidates meet these criteria:
   *   - Age > 2 hours
   *   - Estimated confidence > 0.65
   *
   * Candidates are returned in descending order of estimated confidence
   * (highest confidence first).
   *
   * @returns Array of consolidation candidates. Empty if no episodes qualify.
   */
  findConsolidationCandidates(): readonly ConsolidationCandidate[];

  /**
   * Convert an episode into semantic WKG content.
   *
   * Extracts entities and relationships from the episode. Does not write
   * to the WKG; returns the conversion ready for Learning subsystem handoff.
   *
   * Entity extraction: simple tokenization of inputSummary for noun phrases.
   * Relationship extraction: action → predicted effect, input → action triples.
   *
   * Provenance is determined from the episode's drive snapshot feedback type:
   *   - confirmation / correction → GUARDIAN
   *   - none → INFERENCE
   *
   * @param episode - The episode to convert.
   * @returns A SemanticConversion object with extracted entities and relationships.
   */
  convertToSemantic(episode: Episode): SemanticConversion;

  /**
   * Consolidate a single candidate episode.
   *
   * Converts the candidate to semantic content, logs the intent to the event
   * backbone, and tracks the result. Does not write to the WKG (Learning
   * subsystem owns WKG persistence).
   *
   * Consolidation failures are logged but do not throw; the episode remains
   * in episodic memory for later retry.
   *
   * @param candidate - The consolidation candidate to process.
   * @returns ConsolidationResult with success flag and conversion count.
   */
  consolidate(candidate: ConsolidationCandidate): Promise<ConsolidationResult>;

  /**
   * Run a full consolidation cycle.
   *
   * Finds all candidates in episodic memory, consolidates each, and returns
   * aggregated results. This is typically called periodically (e.g., every
   * 30 minutes) to promote mature episodes to the WKG.
   *
   * @returns Array of ConsolidationResult, one per consolidated episode.
   */
  runConsolidationCycle(): Promise<readonly ConsolidationResult[]>;
}
