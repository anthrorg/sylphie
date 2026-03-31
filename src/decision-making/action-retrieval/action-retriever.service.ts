/**
 * IActionRetrieverService implementation.
 *
 * Retrieves action procedure candidates from the World Knowledge Graph and
 * assigns motivating drives for Ashby Loop 4 analysis. Bootstraps with seed
 * procedure nodes on cold start.
 *
 * CANON §Confidence Dynamics: Retrieval threshold is 0.50. Nodes below this
 * are not returned by default WKG queries. Uses Jaccard similarity on context
 * fingerprints to compute contextMatchScore for tiebreaking.
 *
 * CANON §Drive Assignment: The motivating drive is the highest-pressure drive
 * from the current DriveSnapshot, enabling the system to track which needs were
 * driving action selection for prediction evaluation (Ashby Loop 4).
 *
 * CANON §Type 1 / Type 2 Discipline: All retrieved candidates must exceed
 * the confidence threshold; the Shrug Imperative (Standard 4) is enforced by
 * returning an empty array when no candidates qualify.
 *
 * Context Caching: An LRU cache with 50-entry limit and 5-minute TTL reduces
 * WKG query load for repeated contexts.
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import type { ActionCandidate, ActionProcedureData, ActionStep } from '../../shared/types/action.types';
import type { DriveSnapshot, DriveName } from '../../shared/types/drive.types';
import { DRIVE_INDEX_ORDER } from '../../shared/types/drive.types';
import { CONFIDENCE_THRESHOLDS } from '../../shared/types/confidence.types';
import { IActionRetrieverService } from '../interfaces/decision-making.interfaces';
import type { IWkgService } from '../../knowledge/interfaces/knowledge.interfaces';
import { WKG_SERVICE } from '../../knowledge/knowledge.tokens';

// ---------------------------------------------------------------------------
// LRU Cache Entry Type
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  cachedAt: Date;
}

// ---------------------------------------------------------------------------
// Bootstrap Seed Data
// ---------------------------------------------------------------------------

interface SeedProcedure {
  name: string;
  category: string;
  triggerContext: string;
  actionSequence: readonly ActionStep[];
}

/**
 * Seed procedures for cold start bootstrap.
 * Each carries SYSTEM_BOOTSTRAP provenance and base confidence 0.40.
 */
const SEED_PROCEDURES: readonly SeedProcedure[] = [
  {
    name: 'greet',
    category: 'ConversationalResponse',
    triggerContext: 'greeting hello hi welcome',
    actionSequence: [
      {
        index: 0,
        stepType: 'LLM_GENERATE',
        params: { instruction: 'Generate a warm, personalized greeting.' },
      },
    ],
  },
  {
    name: 'acknowledge',
    category: 'ConversationalResponse',
    triggerContext: 'acknowledge input received understood noted',
    actionSequence: [
      {
        index: 0,
        stepType: 'LLM_GENERATE',
        params: { instruction: 'Acknowledge the user input clearly and briefly.' },
      },
    ],
  },
  {
    name: 'ask_clarification',
    category: 'ConversationalResponse',
    triggerContext: 'clarify unclear ambiguous question unclear',
    actionSequence: [
      {
        index: 0,
        stepType: 'LLM_GENERATE',
        params: { instruction: 'Ask a focused clarifying question.' },
      },
    ],
  },
  {
    name: 'express_curiosity',
    category: 'ConversationalResponse',
    triggerContext: 'curiosity explore learn discover interest topic',
    actionSequence: [
      {
        index: 0,
        stepType: 'LLM_GENERATE',
        params: { instruction: 'Express genuine curiosity about the topic.' },
      },
    ],
  },
  {
    name: 'shrug',
    category: 'ConversationalResponse',
    triggerContext: 'shrug incomprehension unclear unknown',
    actionSequence: [
      {
        index: 0,
        stepType: 'LLM_GENERATE',
        params: { instruction: 'Signal incomprehension honestly. Do not guess.' },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// ActionRetrieverService
// ---------------------------------------------------------------------------

@Injectable()
export class ActionRetrieverService implements IActionRetrieverService {
  private readonly logger = new Logger(ActionRetrieverService.name);

  /**
   * LRU cache mapping context fingerprints to retrieved action candidates.
   * Key: context fingerprint string
   * Value: { value: ActionCandidate[], cachedAt: Date }
   */
  private readonly contextCache = new Map<string, CacheEntry<ActionCandidate[]>>();

  /** Maximum number of entries in the LRU cache. */
  private readonly MAX_CACHE_SIZE = 50;

  /** TTL for cached entries in milliseconds (5 minutes). */
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;

  constructor(
    @Optional()
    @Inject(WKG_SERVICE)
    private readonly wkgService?: IWkgService,
  ) {}

  /**
   * Retrieve action candidates matching the given context from the WKG.
   *
   * 1. Checks LRU cache for context fingerprint (hit + not expired = return cached)
   * 2. On cache miss: queries WKG for procedure nodes with confidence >= 0.50
   * 3. Computes Jaccard similarity of triggerContext vs. contextFingerprint
   * 4. Assigns motivating drive = highest positive drive from driveSnapshot
   * 5. Sorts by confidence descending
   * 6. Caches and returns the candidates
   *
   * If WKG is not available (optional injection), returns empty array gracefully.
   * An empty return is valid — it triggers the Type 2 path per the Shrug Imperative.
   *
   * @param contextFingerprint - Semantic fingerprint of the current context.
   * @param driveSnapshot      - Current drive state for motivating drive assignment.
   * @returns Array of ActionCandidate records, sorted by confidence descending.
   */
  async retrieve(
    contextFingerprint: string,
    driveSnapshot: DriveSnapshot,
  ): Promise<ActionCandidate[]> {
    // Check LRU cache first.
    const cached = this.contextCache.get(contextFingerprint);
    if (cached !== undefined) {
      const age = Date.now() - cached.cachedAt.getTime();
      if (age < this.CACHE_TTL_MS) {
        this.logger.debug(
          `[ActionRetriever] Cache hit for fingerprint "${contextFingerprint}" (age ${age}ms)`,
        );
        return cached.value;
      } else {
        // Expired; remove from cache.
        this.contextCache.delete(contextFingerprint);
      }
    }

    // Cache miss or expired. Query WKG if available.
    let candidates: ActionCandidate[] = [];

    if (this.wkgService) {
      try {
        // Query WKG for procedure nodes. The service applies retrieval threshold (0.50).
        const wkgCandidates = await this.wkgService.queryActionCandidates(
          'ActionProcedure',
          CONFIDENCE_THRESHOLDS.retrieval,
        );

        // Compute context match scores and assign motivating drives.
        candidates = wkgCandidates.map((candidate) => ({
          ...candidate,
          contextMatchScore: this.jaccardSimilarity(
            candidate.procedureData?.triggerContext ?? '',
            contextFingerprint,
          ),
          motivatingDrive: this.getHighestPressureDrive(driveSnapshot),
        }));

        // Sort by confidence descending.
        candidates.sort((a, b) => b.confidence - a.confidence);
      } catch (error) {
        this.logger.warn(
          `[ActionRetriever] WKG query failed for context "${contextFingerprint}": ${error instanceof Error ? error.message : String(error)}`,
        );
        // Graceful degradation: return empty array, allowing Type 2 to take over.
        candidates = [];
      }
    } else {
      this.logger.debug('[ActionRetriever] WKG service not available; returning empty candidates');
    }

    // Cache the result (even if empty).
    this.updateCache(contextFingerprint, candidates);

    return candidates;
  }

  /**
   * Bootstrap the action tree with seed procedure nodes on cold start.
   *
   * Creates five seed procedure nodes with SYSTEM_BOOTSTRAP provenance:
   * - greet: greeting response
   * - acknowledge: acknowledge user input
   * - ask_clarification: request clarification
   * - express_curiosity: express interest in a topic
   * - shrug: signal incomprehension
   *
   * Each seed node has:
   * - Base confidence: 0.40 (SYSTEM_BOOTSTRAP maps to SENSOR base)
   * - Provenance: SYSTEM_BOOTSTRAP
   * - Simple action sequence with LLM_GENERATE step
   *
   * Actual WKG writes are deferred (graceful when WKG unavailable).
   * Logs seed creation for diagnostics.
   *
   * @throws DecisionMakingException only if a critical WKG write fails and
   *         the system cannot bootstrap. Gracefully degrades if WKG unavailable.
   */
  async bootstrapActionTree(): Promise<void> {
    if (!this.wkgService) {
      this.logger.warn(
        '[ActionRetriever] WKG service not available; cannot bootstrap seed procedures',
      );
      return;
    }

    this.logger.log('[ActionRetriever] Bootstrapping action tree with seed procedures...');

    for (const seed of SEED_PROCEDURES) {
      try {
        // Upsert the procedure node.
        await this.wkgService.upsertNode({
          labels: ['ActionProcedure', seed.category],
          nodeLevel: 'SCHEMA',
          properties: {
            name: seed.name,
            category: seed.category,
            triggerContext: seed.triggerContext,
            actionSequence: seed.actionSequence,
          },
          initialConfidence: 0.40, // SYSTEM_BOOTSTRAP → SENSOR base
          provenance: 'SYSTEM_BOOTSTRAP',
        });

        this.logger.debug(`[ActionRetriever] Bootstrapped seed procedure: "${seed.name}"`);
      } catch (error) {
        this.logger.warn(
          `[ActionRetriever] Failed to bootstrap seed procedure "${seed.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
        // Continue bootstrapping other seeds rather than failing hard.
      }
    }

    this.logger.log('[ActionRetriever] Seed bootstrap complete');
  }

  /**
   * Compute Jaccard similarity between two space-separated token strings.
   *
   * Jaccard(A, B) = |A ∩ B| / |A ∪ B|
   *
   * Used to score how well a procedure's triggerContext matches the current
   * contextFingerprint. Higher score = better match.
   *
   * @param triggerContext - Space-separated tokens from a procedure's context.
   * @param contextFingerprint - Space-separated tokens of the current context.
   * @returns Similarity score in [0.0, 1.0]
   */
  private jaccardSimilarity(triggerContext: string, contextFingerprint: string): number {
    const splitTokens = (s: string): Set<string> => {
      return new Set(s.toLowerCase().split(/\s+/).filter((t) => t.length > 0));
    };

    const triggerSet = splitTokens(triggerContext);
    const contextSet = splitTokens(contextFingerprint);

    if (triggerSet.size === 0 && contextSet.size === 0) {
      return 1.0; // Both empty → perfect match.
    }

    if (triggerSet.size === 0 || contextSet.size === 0) {
      return 0.0; // One empty, one not → no match.
    }

    // Compute intersection and union.
    const intersection = new Set([...triggerSet].filter((t) => contextSet.has(t)));
    const union = new Set([...triggerSet, ...contextSet]);

    return intersection.size / union.size;
  }

  /**
   * Get the highest-pressure drive from the current DriveSnapshot.
   *
   * Iterates through all drives in DRIVE_INDEX_ORDER and returns the DriveName
   * with the maximum positive pressure. If all drives are <= 0, returns the
   * first drive in DRIVE_INDEX_ORDER as a fallback.
   *
   * Required for Ashby Loop 4: the motivating drive is used to detect whether
   * action selection is producing relief for the drive that motivated it.
   *
   * @param driveSnapshot - Current drive state.
   * @returns The DriveName of the highest-pressure drive.
   */
  private getHighestPressureDrive(driveSnapshot: DriveSnapshot): DriveName {
    let highestDrive = DRIVE_INDEX_ORDER[0];
    let highestPressure = driveSnapshot.pressureVector[highestDrive];

    for (const driveName of DRIVE_INDEX_ORDER) {
      const pressure = driveSnapshot.pressureVector[driveName];
      if (pressure > highestPressure) {
        highestPressure = pressure;
        highestDrive = driveName;
      }
    }

    return highestDrive;
  }

  /**
   * Update the LRU cache with a new entry.
   *
   * If the cache has reached MAX_CACHE_SIZE, removes the oldest entry (LRU).
   * Inserts the new entry at the end (most recent).
   *
   * @param key - Context fingerprint string.
   * @param candidates - Retrieved action candidates to cache.
   */
  private updateCache(key: string, candidates: ActionCandidate[]): void {
    // If already present, delete it so we can re-insert at the end (LRU).
    if (this.contextCache.has(key)) {
      this.contextCache.delete(key);
    }

    // If at capacity, remove the oldest (first) entry.
    if (this.contextCache.size >= this.MAX_CACHE_SIZE) {
      const oldestKey = this.contextCache.keys().next().value;
      this.contextCache.delete(oldestKey);
    }

    // Insert the new entry.
    this.contextCache.set(key, {
      value: candidates,
      cachedAt: new Date(),
    });
  }
}
