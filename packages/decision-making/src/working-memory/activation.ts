/**
 * Pure activation scoring functions for the working memory buffer.
 *
 * All functions are deterministic: same inputs produce same outputs, no
 * side effects, no randomness. This makes the working memory buffer
 * fully reproducible for testing and debugging.
 *
 * The activation model draws from ACT-R's base-level activation equation
 * (already used for WKG confidence in this codebase) and the spreading
 * activation system in the Python perception service (cobeing/layer3_knowledge).
 *
 * Constants are aligned with the Python spreading_activation.py parameters
 * so the TypeScript and Python systems share the same cognitive semantics.
 */

import type { PressureVector } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Initial activation boost for seed entities (matches Python DEFAULT_INITIAL_BOOST). */
export const INITIAL_BOOST = 0.20;

/** Decay factor per hop in spreading activation (matches Python DEFAULT_HOP_DECAY_FACTOR). */
export const HOP_DECAY_FACTOR = 0.60;

/** Maximum BFS depth for spreading activation (matches Python developmental stage). */
export const MAX_PROPAGATION_DEPTH = 2;

/** Maximum number of items that can receive spreading boost (matches Python DEFAULT_BUDGET_CEILING). */
export const ACTIVATION_BUDGET = 30;

/** Boosts below this threshold are discarded (matches Python DEFAULT_MIN_ACTIVATION_THRESHOLD). */
export const MIN_ACTIVATION_THRESHOLD = 0.01;

/** Temporal decay rate for recency scoring (matches episodic memory ageWeight formula). */
export const RECENCY_DECAY_RATE = 0.10;

/** Maximum additive spreading boost per item. */
export const MAX_SPREADING_BOOST = 0.20;

/** Activation weight for input relevance. */
export const W_RELEVANCE = 0.40;

/** Activation weight for source confidence. */
export const W_CONFIDENCE = 0.20;

/** Activation weight for temporal recency. */
export const W_RECENCY = 0.20;

/** Activation weight for drive modulation. */
export const W_DRIVE = 0.20;

/** Maximum items in the working memory buffer. */
export const MAX_SLOT_COUNT = 40;

/** Default token budget for the working memory snapshot. */
export const DEFAULT_TOKEN_BUDGET = 1500;

/** Conservative characters-per-token estimate (matches ContextWindowService). */
const CHARS_PER_TOKEN = 3.5;

/** Per-item overhead for line formatting in the summary. */
const ITEM_OVERHEAD_TOKENS = 2;

// ---------------------------------------------------------------------------
// Activation weights tuple
// ---------------------------------------------------------------------------

export interface ActivationWeights {
  readonly relevance: number;
  readonly confidence: number;
  readonly recency: number;
  readonly drive: number;
}

export const DEFAULT_WEIGHTS: ActivationWeights = {
  relevance: W_RELEVANCE,
  confidence: W_CONFIDENCE,
  recency: W_RECENCY,
  drive: W_DRIVE,
};

// ---------------------------------------------------------------------------
// Spreading activation parameters
// ---------------------------------------------------------------------------

export interface SpreadingActivationParams {
  readonly initialBoost: number;
  readonly hopDecayFactor: number;
  readonly maxDepth: number;
  readonly budget: number;
  readonly minThreshold: number;
}

export const DEFAULT_SPREADING_PARAMS: SpreadingActivationParams = {
  initialBoost: INITIAL_BOOST,
  hopDecayFactor: HOP_DECAY_FACTOR,
  maxDepth: MAX_PROPAGATION_DEPTH,
  budget: ACTIVATION_BUDGET,
  minThreshold: MIN_ACTIVATION_THRESHOLD,
};

// ---------------------------------------------------------------------------
// Text tokenization
// ---------------------------------------------------------------------------

/**
 * Tokenize text into a set of lowercased words.
 * Strips punctuation and filters empty strings.
 */
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[.,!?;:'"()[\]{}]/g, ''))
      .filter((w) => w.length > 0),
  );
}

/**
 * Compute Jaccard similarity between two token sets.
 * Returns 0 when both sets are empty.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;

  for (const token of smaller) {
    if (larger.has(token)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Entity extraction (same heuristic as wkg-context.service.ts)
// ---------------------------------------------------------------------------

/**
 * Extract potential entity names from text.
 * Capitalized words are treated as proper nouns; significant lowercase
 * words (4+ chars) are included for concept matching.
 */
export function extractEntityNames(text: string): string[] {
  const words = text.split(/\s+/);
  const entities: string[] = [];

  for (const word of words) {
    const clean = word.replace(/[.,!?;:'"()[\]{}]/g, '');
    if (clean.length > 1 && /^[A-Z]/.test(clean)) {
      entities.push(clean);
    }
  }

  const lower = text.toLowerCase();
  const conceptWords = lower
    .split(/\s+/)
    .filter((w) => w.length > 4)
    .map((w) => w.replace(/[.,!?;:'"()[\]{}]/g, ''));

  return [...new Set([...entities, ...conceptWords])];
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the token count for a text string.
 * Uses the same conservative heuristic as ContextWindowService (3.5 chars/token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN) + ITEM_OVERHEAD_TOKENS;
}

// ---------------------------------------------------------------------------
// Activation sub-scores
// ---------------------------------------------------------------------------

/**
 * Compute relevance score between an item and the current frame.
 *
 * Uses Jaccard similarity on word tokens, plus a bonus for entity label
 * overlap with frame entity names.
 *
 * @param itemTokens   - Lowercased word tokens from the item text.
 * @param frameTokens  - Lowercased word tokens from the frame input text.
 * @param entityOverlap - Whether any of the item's entity labels match frame entities.
 * @returns Score in [0.0, 1.0].
 */
export function computeRelevanceScore(
  itemTokens: Set<string>,
  frameTokens: Set<string>,
  entityOverlap: boolean,
): number {
  const jaccard = jaccardSimilarity(itemTokens, frameTokens);
  const bonus = entityOverlap ? 0.30 : 0;
  return Math.min(1.0, jaccard + bonus);
}

/**
 * Compute temporal recency score.
 *
 * Uses the ACT-R-compatible exponential decay already used by episodic memory:
 * score = exp(-decayRate * hoursSinceSource)
 *
 * @param sourceTimestamp - When the source data was created.
 * @param now            - Current wall-clock time.
 * @param decayRate      - Decay rate (default: 0.10, matches episodic ageWeight).
 * @returns Score in [0.0, 1.0].
 */
export function computeRecencyScore(
  sourceTimestamp: Date,
  now: Date,
  decayRate: number = RECENCY_DECAY_RATE,
): number {
  const hoursSince = (now.getTime() - sourceTimestamp.getTime()) / 3_600_000;
  if (hoursSince <= 0) return 1.0;
  return Math.exp(-decayRate * hoursSince);
}

/**
 * Compute drive modulation score.
 *
 * Returns the maximum pressure among the item's associated drives.
 * If no drives are associated, returns 0.
 *
 * @param associatedDrives - Drive names associated with this item.
 * @param pressureVector   - Current drive pressure values.
 * @returns Score in [0.0, 1.0].
 */
export function computeDriveModulation(
  associatedDrives: readonly string[],
  pressureVector: PressureVector,
): number {
  if (associatedDrives.length === 0) return 0;

  let maxPressure = 0;
  for (const drive of associatedDrives) {
    const pressure = (pressureVector as unknown as Record<string, number>)[drive];
    if (typeof pressure === 'number' && pressure > maxPressure) {
      maxPressure = pressure;
    }
  }

  return Math.max(0, Math.min(1.0, maxPressure));
}

/**
 * Compute the composite activation score.
 *
 * Weighted sum of sub-scores plus additive spreading boost, clamped to [0, 1].
 *
 * @param relevance      - Relevance to current input [0, 1].
 * @param confidence     - Source confidence [0, 1].
 * @param recency        - Temporal recency [0, 1].
 * @param driveModulation - Drive pressure modulation [0, 1].
 * @param spreadingBoost - Spreading activation boost [0, MAX_SPREADING_BOOST].
 * @param weights        - Weight coefficients for each sub-score.
 * @returns Composite activation in [0.0, 1.0].
 */
export function computeActivation(
  relevance: number,
  confidence: number,
  recency: number,
  driveModulation: number,
  spreadingBoost: number,
  weights: ActivationWeights = DEFAULT_WEIGHTS,
): number {
  const raw =
    weights.relevance * relevance +
    weights.confidence * confidence +
    weights.recency * recency +
    weights.drive * driveModulation +
    Math.min(spreadingBoost, MAX_SPREADING_BOOST);

  return Math.max(0, Math.min(1.0, raw));
}

// ---------------------------------------------------------------------------
// Spreading Activation
// ---------------------------------------------------------------------------

/**
 * Adjacency map: entity label (lowercased) -> set of connected entity labels.
 */
export type AdjacencyMap = Map<string, Set<string>>;

/**
 * Run spreading activation from seed entities through the adjacency map.
 *
 * BFS propagation with hop-based decay. Uses MAX accumulation strategy
 * (matching Python Layer 2 / Ashby): if a new activation value is greater
 * than the existing one, it replaces it; otherwise the existing value is kept.
 *
 * @param seedLabels   - Entity labels extracted from the current input (lowercased).
 * @param adjacencyMap - Bidirectional adjacency built from WKG relationships.
 * @param params       - Spreading activation parameters.
 * @returns Map from entity label (lowercased) to activation boost.
 */
export function spreadActivation(
  seedLabels: readonly string[],
  adjacencyMap: AdjacencyMap,
  params: SpreadingActivationParams = DEFAULT_SPREADING_PARAMS,
): Map<string, number> {
  const activationMap = new Map<string, number>();

  // BFS queue: [label, currentDepth, currentBoost]
  const queue: Array<[string, number, number]> = [];

  // Initialize seeds
  for (const label of seedLabels) {
    const lower = label.toLowerCase();
    const existing = activationMap.get(lower) ?? 0;
    if (params.initialBoost > existing) {
      activationMap.set(lower, params.initialBoost);
    }
    queue.push([lower, 0, params.initialBoost]);
  }

  // BFS propagation
  while (queue.length > 0) {
    const [currentLabel, depth, currentBoost] = queue.shift()!;

    if (depth >= params.maxDepth) continue;

    const neighbors = adjacencyMap.get(currentLabel);
    if (!neighbors) continue;

    const nextBoost = currentBoost * params.hopDecayFactor;
    if (nextBoost < params.minThreshold) continue;

    for (const neighbor of neighbors) {
      const existing = activationMap.get(neighbor) ?? 0;

      // MAX accumulation: only update if new boost is higher
      if (nextBoost > existing) {
        activationMap.set(neighbor, nextBoost);
        queue.push([neighbor, depth + 1, nextBoost]);
      }
    }
  }

  // Budget enforcement: keep only top-N by boost value
  if (activationMap.size > params.budget) {
    const sorted = [...activationMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, params.budget);
    activationMap.clear();
    for (const [label, boost] of sorted) {
      activationMap.set(label, boost);
    }
  }

  return activationMap;
}

/**
 * Build a bidirectional adjacency map from WKG relationships.
 *
 * Keys are lowercased entity labels. The entity ID-to-label mapping is
 * required because relationships reference nodes by ID, not label.
 *
 * @param relationships - WKG relationships from the current context.
 * @param entityIdToLabel - Map from node ID to entity label.
 * @returns Bidirectional adjacency map keyed by lowercased label.
 */
export function buildAdjacencyMap(
  relationships: readonly { sourceId: string; targetId: string }[],
  entityIdToLabel: ReadonlyMap<string, string>,
): AdjacencyMap {
  const map: AdjacencyMap = new Map();

  for (const rel of relationships) {
    const sourceLabel = entityIdToLabel.get(rel.sourceId)?.toLowerCase();
    const targetLabel = entityIdToLabel.get(rel.targetId)?.toLowerCase();

    if (!sourceLabel || !targetLabel) continue;

    if (!map.has(sourceLabel)) map.set(sourceLabel, new Set());
    if (!map.has(targetLabel)) map.set(targetLabel, new Set());

    map.get(sourceLabel)!.add(targetLabel);
    map.get(targetLabel)!.add(sourceLabel);
  }

  return map;
}
