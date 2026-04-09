/**
 * Working Memory types for the activation-driven context buffer.
 *
 * Working memory sits between raw data sources (WKG, episodic memory, drives,
 * perception) and the deliberation pipeline. Items from different sources
 * compete for slots based on activation — a composite of relevance to the
 * current sensory frame, source confidence, temporal recency, drive modulation,
 * and spreading activation from WKG graph connections.
 *
 * The buffer enforces a fixed capacity (slot count + token budget) and evicts
 * lowest-activation items. Minimum source guarantees prevent any single source
 * from starving others.
 *
 * CANON §Subsystem 1 (Decision Making): Working memory is the "spotlight"
 * that selects which knowledge is relevant to the current decision cycle.
 * It does not store or modify knowledge — it only selects and activates.
 */

// ---------------------------------------------------------------------------
// Source Type
// ---------------------------------------------------------------------------

/**
 * Discriminator for working memory item origin.
 *
 * Each source type has different rules for how activation sub-scores are
 * computed (e.g., WKG items use WKG confidence, episodes use ageWeight).
 */
export type WorkingMemorySourceType =
  | 'WKG_FACT'
  | 'WKG_ENTITY'
  | 'EPISODE'
  | 'DRIVE'
  | 'SCENE'
  | 'PROCEDURE';

// ---------------------------------------------------------------------------
// Working Memory Item
// ---------------------------------------------------------------------------

/**
 * A single item in the working memory buffer.
 *
 * Items compete for slots based on their activation score. The score is a
 * weighted composite of relevance, confidence, recency, drive modulation,
 * and spreading activation boost.
 *
 * Token cost is estimated at construction time so the buffer can enforce a
 * total token budget without re-measuring on every read.
 */
export interface WorkingMemoryItem {
  /** Stable ID for deduplication (WKG nodeId, episode id, drive name, etc.). */
  readonly id: string;

  /** Which data source this item originated from. */
  readonly sourceType: WorkingMemorySourceType;

  /** Human-readable text representation for LLM injection. */
  readonly text: string;

  /** Current activation score [0.0, 1.0]. Drives eviction priority. */
  readonly activation: number;

  /** Estimated token cost of this item's text representation. */
  readonly estimatedTokens: number;

  /** Entity labels mentioned or associated with this item (lowercased). */
  readonly entityLabels: readonly string[];

  /** Drive names associated with this item (for drive modulation). */
  readonly associatedDrives: readonly string[];

  /** Confidence from the source (WKG confidence, episode ageWeight, 1.0 for drives/scene). */
  readonly sourceConfidence: number;

  /** Timestamp of the source data (for temporal decay). */
  readonly sourceTimestamp: Date;

  /** Spreading activation boost received from cross-source interaction [0.0, 0.20]. */
  readonly spreadingBoost: number;
}

// ---------------------------------------------------------------------------
// Working Memory Snapshot
// ---------------------------------------------------------------------------

/**
 * Immutable snapshot of working memory state, consumed by the deliberation
 * pipeline in place of flat-concatenated summaries.
 *
 * Token-bounded: totalEstimatedTokens <= tokenBudget.
 */
export interface WorkingMemorySnapshot {
  /** Items in the buffer, sorted by activation descending. */
  readonly items: readonly WorkingMemoryItem[];

  /** Formatted summary string for LLM system prompt injection. */
  readonly formattedSummary: string;

  /** Per-source counts for diagnostics. */
  readonly sourceCounts: Readonly<Record<WorkingMemorySourceType, number>>;

  /** Total estimated tokens across all items. */
  readonly totalEstimatedTokens: number;

  /** The token budget that was enforced. */
  readonly tokenBudget: number;

  /** Number of items that were evicted due to capacity/budget constraints. */
  readonly evictedCount: number;

  /** The wall-clock time when this snapshot was assembled. */
  readonly assembledAt: Date;

  /** Entity labels that received spreading activation boost. */
  readonly activatedEntities: readonly string[];
}
