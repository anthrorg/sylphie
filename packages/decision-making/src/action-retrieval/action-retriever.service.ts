/**
 * ActionRetrieverService — WKG candidate retrieval with LRU cache.
 *
 * CANON §Subsystem 1 (Decision Making): Retrieves action candidates from the
 * World Knowledge Graph. Each candidate carries a motivating drive (the
 * highest-pressure drive at query time) for Ashby Loop 4 analysis.
 *
 * CANON §Confidence Dynamics: Only procedure nodes with confidence >= 0.50
 * (retrieval threshold) are returned by default queries.
 *
 * CANON §Provenance: Bootstrap seed procedures carry 'SYSTEM_BOOTSTRAP'
 * provenance with base confidence 0.40. They are never elevated unless
 * guardian-confirmed.
 *
 * LRU cache: 50 entries, 5-minute TTL, keyed by context fingerprint.
 * Prevents redundant WKG queries for identical context fingerprints within
 * the same session window.
 *
 * Neo4j is injected @Optional. When unavailable, retrieval returns an empty
 * candidate list (which triggers the Type 2 path) and a debug message is
 * logged rather than throwing. This is intentional graceful degradation.
 *
 * Context similarity is computed with Jaccard similarity on whitespace tokens.
 * This is a lightweight approximation appropriate for fingerprint matching
 * before a proper embedding-based retrieval layer is in place.
 *
 * CANON KNOWN LIMITATION: WKG_SERVICE token is not yet formally defined in
 * decision-making.tokens.ts. Neo4jService from @sylphie/shared is injected
 * directly as a structural placeholder. When WKG_SERVICE is formalised, the
 * injection site here should migrate to that token.
 *
 * Injection token: ACTION_RETRIEVER_SERVICE (decision-making.tokens.ts)
 */

import { Injectable, Logger, Optional, Inject, OnModuleInit } from '@nestjs/common';
import {
  Neo4jService,
  Neo4jInstanceName,
  type ActionCandidate,
  type ActionProcedureData,
  type ActionStep,
  type DriveSnapshot,
  DriveName,
  DRIVE_INDEX_ORDER,
  CONFIDENCE_THRESHOLDS,
} from '@sylphie/shared';
import type { IActionRetrieverService } from '../interfaces/decision-making.interfaces';

// ---------------------------------------------------------------------------
// LRU Cache
// ---------------------------------------------------------------------------

/** A single entry in the LRU cache. */
interface CacheEntry {
  readonly candidates: ActionCandidate[];
  readonly expiresAt: number;
}

/** LRU cache capacity (entries). */
const LRU_CAPACITY = 50;

/** Cache entry TTL in milliseconds (5 minutes). */
const LRU_TTL_MS = 5 * 60 * 1000;

/**
 * Minimal LRU cache backed by a Map.
 *
 * Map insertion order is used to approximate LRU: on each hit the key is
 * deleted and re-inserted to move it to the end. On capacity overflow the
 * first (oldest) key is evicted. This is O(1) per operation.
 */
class LruCache {
  private readonly store = new Map<string, CacheEntry>();

  get(key: string): ActionCandidate[] | null {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    // Refresh position.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.candidates;
  }

  set(key: string, candidates: ActionCandidate[]): void {
    // Evict oldest if at capacity.
    if (this.store.size >= LRU_CAPACITY && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, { candidates, expiresAt: Date.now() + LRU_TTL_MS });
  }

  get size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Neo4j query result shapes
// ---------------------------------------------------------------------------

interface ProcedureRow {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly triggerContext: string;
  readonly provenance: string;
  readonly confidence: number;
  readonly driveEffects?: string | null;
}

function isProcedureRow(value: unknown): value is ProcedureRow {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['id'] === 'string' &&
    typeof (value as Record<string, unknown>)['name'] === 'string' &&
    typeof (value as Record<string, unknown>)['triggerContext'] === 'string' &&
    typeof (value as Record<string, unknown>)['confidence'] === 'number'
  );
}

// ---------------------------------------------------------------------------
// ActionRetrieverService
// ---------------------------------------------------------------------------

@Injectable()
export class ActionRetrieverService implements IActionRetrieverService, OnModuleInit {
  private readonly logger = new Logger(ActionRetrieverService.name);
  private readonly cache = new LruCache();

  constructor(
    // Neo4jService used as structural WKG placeholder. Injected @Optional for
    // graceful degradation when the WKG connection is not yet established.
    @Optional() @Inject(Neo4jService) private readonly neo4j: Neo4jService | null,
  ) {}

  /**
   * Bootstrap hook: seeds the WKG with initial action procedures on cold start.
   *
   * If Neo4j is unavailable, the bootstrap is skipped and a warning is logged.
   * The decision cycle will operate in Type 2 mode until WKG connectivity is
   * established.
   */
  async onModuleInit(): Promise<void> {
    if (!this.neo4j) {
      this.logger.warn(
        'ActionRetrieverService: Neo4jService unavailable on init. WKG bootstrap skipped.',
      );
      return;
    }

    try {
      await this.bootstrapActionTree();
    } catch (err) {
      this.logger.warn(`ActionRetrieverService: WKG bootstrap failed: ${err}. Continuing.`);
    }
  }

  /**
   * Retrieve action candidates matching the given context from the WKG.
   *
   * Pipeline:
   *   1. Check LRU cache (keyed by contextFingerprint).
   *   2. If cache miss, query Neo4j for ActionProcedure nodes with
   *      confidence >= retrieval threshold (0.50).
   *   3. Compute Jaccard similarity between each node's triggerContext and
   *      the provided contextFingerprint.
   *   4. Assign the motivating drive (highest-pressure drive in driveSnapshot).
   *   5. Sort by confidence descending.
   *   6. Cache and return.
   *
   * An empty array is a valid result. The arbitration service handles it
   * by entering the Type 2 path.
   *
   * @param contextFingerprint - Semantic fingerprint of the current input context.
   * @param driveSnapshot      - Current drive state for motivating drive assignment.
   * @returns Array of ActionCandidate records. May be empty.
   */
  async retrieve(
    contextFingerprint: string,
    driveSnapshot: DriveSnapshot,
  ): Promise<ActionCandidate[]> {
    // Cache check.
    const cached = this.cache.get(contextFingerprint);
    if (cached !== null) {
      this.logger.debug(
        `ActionRetriever cache hit for fingerprint "${contextFingerprint.slice(0, 30)}..." ` +
          `(${cached.length} candidates)`,
      );
      return cached;
    }

    // WKG unavailable — degrade to empty candidate list.
    if (!this.neo4j) {
      this.logger.debug(
        'ActionRetriever: Neo4jService unavailable, returning empty candidates (Type 2 path).',
      );
      return [];
    }

    // Determine motivating drive before query.
    const motivatingDrive = this.getHighestPressureDrive(driveSnapshot);

    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'READ');
    try {
      const result = await session.run(
        `MATCH (p:ActionProcedure)
         WHERE p.confidence >= $threshold
         RETURN p.id AS id, p.name AS name, p.category AS category,
                p.triggerContext AS triggerContext, p.provenance AS provenance,
                p.confidence AS confidence, p.driveEffects AS driveEffects`,
        { threshold: CONFIDENCE_THRESHOLDS.retrieval },
      );

      const candidates: ActionCandidate[] = result.records
        .map((record) => record.toObject())
        .filter(isProcedureRow)
        .map((row): ActionCandidate => {
          const contextMatchScore = this.jaccardSimilarity(
            contextFingerprint,
            row.triggerContext,
          );

          // Parse driveEffects from the Neo4j node (stored as JSON string)
          let driveEffects: Partial<Record<DriveName, number>> = {};
          try {
            if (row.driveEffects) {
              driveEffects = JSON.parse(row.driveEffects as string);
            }
          } catch {
            // Malformed JSON — use empty effects
          }

          const procedureData: ActionProcedureData = {
            id: row.id,
            name: row.name,
            category: row.category ?? 'ConversationalResponse',
            triggerContext: row.triggerContext,
            actionSequence: [
              {
                index: 0,
                stepType: 'LLM_GENERATE',
                params: {},
              } satisfies ActionStep,
            ],
            provenance: row.provenance as ActionProcedureData['provenance'],
            confidence: row.confidence,
            driveEffects,
          };

          return {
            procedureData,
            confidence: row.confidence,
            motivatingDrive,
            contextMatchScore,
          };
        })
        .sort((a, b) => b.confidence - a.confidence);

      this.logger.debug(
        `ActionRetriever: retrieved ${candidates.length} candidates from WKG ` +
          `(motivatingDrive: ${motivatingDrive})`,
      );

      this.cache.set(contextFingerprint, candidates);
      return candidates;
    } catch (err) {
      this.logger.warn(`ActionRetriever: WKG query failed: ${err}. Returning empty candidates.`);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * Bootstrap the WKG with 5 seed action procedures on cold start.
   *
   * Seeds are created only if no ActionProcedure nodes already exist. Uses
   * MERGE semantics to be safe across restarts. Seed procedures carry
   * SYSTEM_BOOTSTRAP provenance and base confidence 0.40.
   *
   * Seeds created:
   *   - greet: Opening social contact
   *   - acknowledge: Confirming receipt of input
   *   - ask_clarification: Requesting disambiguation
   *   - express_curiosity: Surfacing epistemic drive
   *   - shrug: Signalling incomprehension (Shrug Imperative fallback)
   *
   * @throws If the Neo4j write fails and the WKG cannot be seeded.
   */
  async bootstrapActionTree(): Promise<void> {
    if (!this.neo4j) {
      this.logger.warn('ActionRetriever: bootstrapActionTree called with no Neo4jService.');
      return;
    }

    const seeds: Array<{
      id: string;
      name: string;
      category: string;
      triggerContext: string;
      driveEffects: Record<string, number>;
    }> = [
      {
        id: 'seed-greet',
        name: 'greet',
        category: 'SocialComment',
        triggerContext: 'hello hi greet greeting welcome',
        driveEffects: {
          Social: -0.15,       // Primary relief: social need met
          Boredom: -0.05,      // Mild: interaction reduces boredom
        },
      },
      {
        id: 'seed-acknowledge',
        name: 'acknowledge',
        category: 'ConversationalResponse',
        triggerContext: 'acknowledged understood received got it okay',
        driveEffects: {
          Integrity: -0.05,    // Responding honestly maintains integrity
          Social: -0.05,       // Mild social relief from engagement
        },
      },
      {
        id: 'seed-ask-clarification',
        name: 'ask_clarification',
        category: 'KnowledgeQuery',
        triggerContext: 'unclear ambiguous unknown what do you mean clarify',
        driveEffects: {
          'Cognitive Awareness': -0.1, // Primary: seeking clarity reduces cognitive pressure
          Curiosity: -0.1,     // Asking satisfies curiosity
          Anxiety: -0.05,      // Reducing ambiguity reduces anxiety
        },
      },
      {
        id: 'seed-express-curiosity',
        name: 'express_curiosity',
        category: 'GuardianEngagement',
        triggerContext: 'interesting curious tell me more want to know learn',
        driveEffects: {
          Curiosity: -0.15,    // Primary relief: curiosity satisfied
          Boredom: -0.1,       // Exploring is not boring
          Social: -0.1,        // Engaging with guardian
        },
      },
      {
        id: 'seed-shrug',
        name: 'shrug',
        category: 'SelfCorrection',
        triggerContext: 'unknown uncertain incomprehensible cannot respond',
        driveEffects: {
          Integrity: -0.1,     // Honest about not knowing (CANON Standard 4)
          'Moral Valence': -0.05, // Acting with honesty
        },
      },
    ];

    const BASE_CONFIDENCE = 0.40;

    // Check whether seeds already exist and write new ones in a single session.
    const session = this.neo4j.getSession(Neo4jInstanceName.WORLD, 'WRITE');
    try {
      const existingResult = await session.run(
        'MATCH (p:ActionProcedure) RETURN count(p) AS cnt',
        {},
      );

      const firstRecord = existingResult.records[0];
      const existingCount =
        firstRecord !== undefined
          ? (firstRecord.toObject()['cnt'] as number | undefined) ?? 0
          : 0;

      if (existingCount > 0) {
        this.logger.debug(
          `ActionRetriever: WKG already contains ${existingCount} ActionProcedure nodes. Skipping bootstrap.`,
        );
        return;
      }

      for (const seed of seeds) {
        await session.run(
          `MERGE (p:ActionProcedure {id: $id})
           ON CREATE SET
             p.name = $name,
             p.category = $category,
             p.triggerContext = $triggerContext,
             p.provenance = $provenance,
             p.confidence = $confidence,
             p.driveEffects = $driveEffects,
             p.createdAt = datetime()`,
          {
            id: seed.id,
            name: seed.name,
            category: seed.category,
            triggerContext: seed.triggerContext,
            provenance: 'SYSTEM_BOOTSTRAP',
            confidence: BASE_CONFIDENCE,
            driveEffects: JSON.stringify(seed.driveEffects),
          },
        );

        this.logger.debug(`ActionRetriever: seeded procedure "${seed.name}" (id: ${seed.id})`);
      }

      this.logger.log(
        `ActionRetriever: WKG bootstrapped with ${seeds.length} seed procedures ` +
          `(provenance: SYSTEM_BOOTSTRAP, confidence: ${BASE_CONFIDENCE})`,
      );
    } finally {
      await session.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Private utilities
  // ---------------------------------------------------------------------------

  /**
   * Compute Jaccard similarity between two strings tokenized on whitespace.
   *
   * Jaccard(A, B) = |A ∩ B| / |A ∪ B|
   *
   * Returns 0.0 if either string is empty. Returns 1.0 for identical strings.
   * This is a lightweight approximation used for fingerprint matching before
   * a proper embedding layer is available.
   *
   * @param a - First string.
   * @param b - Second string.
   * @returns Jaccard similarity in [0.0, 1.0].
   */
  private jaccardSimilarity(a: string, b: string): number {
    const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
    const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));

    if (tokensA.size === 0 || tokensB.size === 0) {
      return 0.0;
    }

    let intersectionCount = 0;
    for (const token of tokensA) {
      if (tokensB.has(token)) {
        intersectionCount++;
      }
    }

    const unionCount = tokensA.size + tokensB.size - intersectionCount;
    return intersectionCount / unionCount;
  }

  /**
   * Return the DriveName with the highest current pressure value.
   *
   * Iterates DRIVE_INDEX_ORDER so the result is deterministic on ties
   * (first highest-pressure drive in canonical index order wins).
   *
   * @param driveSnapshot - Current drive state snapshot.
   * @returns The DriveName with maximum pressure. Falls back to Curiosity if all
   *          drives are at the same value (including zero).
   */
  private getHighestPressureDrive(driveSnapshot: DriveSnapshot): DriveName {
    const { pressureVector } = driveSnapshot;

    let highestDrive: DriveName = DriveName.Curiosity;
    let highestPressure = -Infinity;

    for (const drive of DRIVE_INDEX_ORDER) {
      const pressure = pressureVector[drive];
      if (pressure > highestPressure) {
        highestPressure = pressure;
        highestDrive = drive;
      }
    }

    return highestDrive;
  }
}
