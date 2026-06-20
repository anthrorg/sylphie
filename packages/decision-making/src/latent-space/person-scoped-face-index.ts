/**
 * PersonScopedFaceIndex — TK-85 POC: privacy-safe face embedding index.
 *
 * PRIVACY INVARIANT (Wave 3 C6 / AD-0020):
 *   Face embeddings carry identity weight and MUST NOT enter the shared
 *   conversational latent index (LatentSpaceService.hotLayer). This index
 *   is the per-person alternative: each personId owns its own face vector
 *   store, and a face written for Person A can NEVER be found when searching
 *   for Person B. Cross-person leakage is structurally impossible because
 *   write and search are both keyed by personId and never share a store.
 *
 * POC isolation proof:
 *   - writeFace(personId, ...) inserts into Map<personId, FaceEntry[]>.
 *   - searchFace(personId, ...) queries ONLY the slice for that personId.
 *   - No method returns data across personId boundaries.
 *   - No entry is ever placed in the shared conversational index.
 *
 * Graduation path:
 *   When a recognized face recurs N times within a person scope and the
 *   entry's recurrence count reaches FACE_GRADUATION_THRESHOLD, the index
 *   marks it graduated. The caller (LatentSpaceService) can then feed the
 *   graduated procedureId into the existing Type1TrackerService path — the
 *   graduation mechanics are unchanged; only the write/search isolation is
 *   new.
 *
 * In-memory only (POC scope):
 *   This is a PROTOTYPE (TK-85 engineering_level: prototype). No DB
 *   persistence is wired — the goal is to prove the isolation invariant
 *   before committing a schema migration. Persistence is a follow-on ticket.
 */

import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { cosineSimilarity } from './vector-math';
import { EMBEDDING_DIM } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A face embedding entry scoped to one person. */
export interface PersonFaceEntry {
  /** Stable UUID for this face pattern (fed to Type1TrackerService). */
  readonly id: string;
  /** personId of the owner — never shared across persons. */
  readonly personId: string;
  /** JL-projected, L2-normalized face embedding (EMBEDDING_DIM). */
  readonly embedding: number[];
  /** How many times this face pattern has been matched and confirmed. */
  recurrenceCount: number;
  /** Whether this entry has graduated to a Type 1 reflex candidate. */
  graduated: boolean;
  /** When the entry was first recorded. */
  readonly createdAt: Date;
  /** When the entry last matched. */
  lastMatchedAt: Date | null;
}

/** Result of a face search within a person scope. */
export interface PersonFaceMatch {
  readonly entry: PersonFaceEntry;
  readonly similarity: number;
  readonly personId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum cosine similarity to accept a face as a match.
 * Conservative: face embeddings from the FaceEncoder are JL-projected,
 * L2-normalized appearance vectors. The threshold is set high to avoid
 * false merges between faces of different people with similar geometry.
 */
const FACE_SIMILARITY_THRESHOLD = 0.92;

/**
 * Number of confirmed recurrences before a face graduates to a Type 1
 * reflex candidate. "Recognized N times within a person scope" (AC-1).
 * Conservative for POC — earns trust through repetition, not assumption.
 */
export const FACE_GRADUATION_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// PersonScopedFaceIndex
// ---------------------------------------------------------------------------

/**
 * Person-scoped face embedding index.
 *
 * Not a NestJS service — instantiated by LatentSpaceService and tested
 * standalone (no DI container needed for the POC). Export as a plain class
 * so it can be tested in isolation without wiring the full module graph.
 */
export class PersonScopedFaceIndex {
  private readonly logger = new Logger(PersonScopedFaceIndex.name);

  /**
   * Per-person face stores. A personId maps to its PRIVATE list of face
   * entries. This Map is the structural isolation: no entry crosses keys.
   */
  private readonly personStores = new Map<string, PersonFaceEntry[]>();

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /**
   * Write a face embedding for a specific person.
   *
   * If a sufficiently similar face (≥ FACE_SIMILARITY_THRESHOLD) is already
   * stored for this person, the existing entry's recurrenceCount is
   * incremented and it is returned (deduplication). Otherwise a new entry is
   * created. This mirrors the hot-layer's "find or create" pattern without
   * touching the shared conversational index.
   *
   * @param personId  The person this face belongs to. Required — without a
   *                  person scope, faces remain dropped (Wave 3 C6 behaviour).
   * @param embedding The JL-projected face embedding (length must be EMBEDDING_DIM).
   * @returns The id of the face entry (new or existing).
   */
  writeFace(personId: string, embedding: number[]): string {
    if (embedding.length !== EMBEDDING_DIM) {
      this.logger.warn(
        `PersonScopedFaceIndex.writeFace: embedding dim ${embedding.length} ≠ ${EMBEDDING_DIM} — rejected.`,
      );
      return '';
    }

    // Zero-vector check: no semantic content (encoder failure / cassette stub).
    const normSq = embedding.reduce((s, v) => s + v * v, 0);
    if (normSq === 0) {
      this.logger.debug(`PersonScopedFaceIndex.writeFace: zero-vector rejected for person ${personId.substring(0, 8)}.`);
      return '';
    }

    const store = this.getOrCreateStore(personId);

    // Deduplication: find an existing entry close enough to this embedding.
    const existing = this.findBestInStore(store, embedding, FACE_SIMILARITY_THRESHOLD);
    if (existing) {
      existing.entry.recurrenceCount++;
      existing.entry.lastMatchedAt = new Date();

      // Check graduation threshold.
      if (
        !existing.entry.graduated &&
        existing.entry.recurrenceCount >= FACE_GRADUATION_THRESHOLD
      ) {
        existing.entry.graduated = true;
        this.logger.log(
          `PersonScopedFaceIndex: face ${existing.entry.id.substring(0, 8)} for person ` +
            `${personId.substring(0, 8)} GRADUATED after ${existing.entry.recurrenceCount} recurrences.`,
        );
      }

      return existing.entry.id;
    }

    // New entry.
    const entry: PersonFaceEntry = {
      id: randomUUID(),
      personId,
      embedding,
      recurrenceCount: 1,
      graduated: false,
      createdAt: new Date(),
      lastMatchedAt: null,
    };

    store.push(entry);

    this.logger.debug(
      `PersonScopedFaceIndex: new face entry ${entry.id.substring(0, 8)} for person ` +
        `${personId.substring(0, 8)} (store size: ${store.length}).`,
    );

    return entry.id;
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  /**
   * Search for a matching face WITHIN a single person's scope.
   *
   * NEVER searches across persons. A face stored for Person A is invisible
   * to a search for Person B — the Map key enforces this structurally.
   *
   * Only graduated entries are returned as reflex candidates (they have
   * demonstrated they recur reliably for this person). Non-graduated entries
   * accumulate recurrences but do not fire Type 1 reflexes yet.
   *
   * @param personId  The person whose face index to search.
   * @param embedding The query embedding.
   * @returns The best-matching graduated face entry, or null.
   */
  searchFace(personId: string, embedding: number[]): PersonFaceMatch | null {
    // Zero-vector guard.
    const normSq = embedding.reduce((s, v) => s + v * v, 0);
    if (normSq === 0) return null;

    const store = this.personStores.get(personId);
    if (!store || store.length === 0) return null;

    // Only consider graduated entries as reflex candidates.
    const graduated = store.filter((e) => e.graduated);
    if (graduated.length === 0) return null;

    const match = this.findBestInStore(graduated, embedding, FACE_SIMILARITY_THRESHOLD);
    if (!match) return null;

    return { entry: match.entry, similarity: match.similarity, personId };
  }

  // ---------------------------------------------------------------------------
  // Introspection (diagnostics / tests)
  // ---------------------------------------------------------------------------

  /** How many face entries exist for a person. */
  storeSize(personId: string): number {
    return this.personStores.get(personId)?.length ?? 0;
  }

  /** How many graduated face entries exist for a person. */
  graduatedCount(personId: string): number {
    return this.personStores.get(personId)?.filter((e) => e.graduated).length ?? 0;
  }

  /** List of personIds with a non-empty face store. */
  knownPersonIds(): string[] {
    return Array.from(this.personStores.keys());
  }

  /** Clear all stores (test seam). */
  clear(): void {
    this.personStores.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getOrCreateStore(personId: string): PersonFaceEntry[] {
    const existing = this.personStores.get(personId);
    if (existing !== undefined) return existing;
    const fresh: PersonFaceEntry[] = [];
    this.personStores.set(personId, fresh);
    return fresh;
  }

  private findBestInStore(
    store: PersonFaceEntry[],
    embedding: number[],
    threshold: number,
  ): { entry: PersonFaceEntry; similarity: number } | null {
    let bestEntry: PersonFaceEntry | null = null;
    let bestSim = -1;

    for (const entry of store) {
      const sim = cosineSimilarity(embedding, entry.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        bestEntry = entry;
      }
    }

    if (!bestEntry || bestSim < threshold) return null;
    return { entry: bestEntry, similarity: bestSim };
  }
}
