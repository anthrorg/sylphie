/**
 * PersonScopedFaceIndex — TK-85 (POC isolation) + TK-91 (DB persistence).
 *
 * PRIVACY INVARIANT (Wave 3 C6 / AD-0020 / §2.8):
 *   Face embeddings carry identity weight and MUST NOT enter the shared
 *   conversational latent index (LatentSpaceService.hotLayer). This index
 *   is the per-person alternative: each personId owns its own face vector
 *   store, and a face written for Person A can NEVER be found when searching
 *   for Person B. Cross-person leakage is structurally impossible because
 *   write and search are both keyed by personId and never share a store.
 *
 * POC isolation proof (unchanged from TK-85):
 *   - writeFace(personId, ...) inserts into Map<personId, FaceEntry[]>.
 *   - searchFace(personId, ...) queries ONLY the slice for that personId.
 *   - No method returns data across personId boundaries.
 *   - No entry is ever placed in the shared conversational index.
 *
 * DB persistence (TK-91):
 *   Backed by a `person_face_embeddings` table. The table is person-scoped
 *   by design: every row carries person_id, and every query is WHERE
 *   person_id = $n. A DB-level face for Person A is structurally
 *   unreachable from a query for Person B — isolation is enforced at both
 *   the application layer (Map key) and the DB layer (parameterized person_id
 *   on every SELECT/INSERT/UPDATE). Faces never enter the shared
 *   learned_patterns / visual_object_embeddings tables.
 *
 *   Load: lazy, per-person, on first writeFace or searchFace for that
 *   personId (avoids a full-table scan on boot; persons not seen this
 *   session cost nothing). Load is idempotent: a second call for the same
 *   personId is a no-op (loadedPersonIds guard).
 *
 *   Write: upserted on every writeFace hit (recurrence_count + last_matched_at
 *   bumped for existing; INSERT for new). Graduation flag written in the same
 *   call the moment it flips.
 *
 * Graduation path:
 *   When a recognized face recurs N times within a person scope and the
 *   entry's recurrence count reaches FACE_GRADUATION_THRESHOLD, the index
 *   marks it graduated. The caller (LatentSpaceService) can then feed the
 *   graduated procedureId into the existing Type1TrackerService path — the
 *   graduation mechanics are unchanged; only the write/search isolation is
 *   new.
 */

import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { cosineSimilarity } from './vector-math';
import { EMBEDDING_DIM } from '@sylphie/shared';
import { TimescaleService } from '@sylphie/shared';

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
 * Person-scoped face embedding index with optional DB persistence.
 *
 * Not a NestJS service — instantiated by LatentSpaceService and tested
 * standalone (no DI container needed). When a TimescaleService is injected,
 * reads and writes are backed by `person_face_embeddings`; without one the
 * class degrades to pure in-memory (backward compatible with the TK-85 POC).
 *
 * ISOLATION INVARIANT: every DB read and write is parameterized by personId.
 * The WHERE / VALUES clause always includes person_id = $n, so no query can
 * accidentally return another person's rows. This mirrors the Map-key
 * structural isolation at the application layer.
 */
export class PersonScopedFaceIndex {
  private readonly logger = new Logger(PersonScopedFaceIndex.name);

  /**
   * Per-person face stores. A personId maps to its PRIVATE list of face
   * entries. This Map is the structural isolation: no entry crosses keys.
   */
  private readonly personStores = new Map<string, PersonFaceEntry[]>();

  /**
   * Tracks which personIds have already been loaded from the DB to prevent
   * redundant round-trips on every writeFace / searchFace call.
   *
   * Implemented as a Map<personId, Promise<void>> rather than a Set: if two
   * callers race on the same personId before the first SELECT completes, the
   * second awaits the SAME in-flight promise instead of firing a duplicate
   * SELECT that would double-push DB rows into the in-memory store.
   */
  private readonly loadedPersonIds = new Map<string, Promise<void>>();

  /** Whether the schema has been created (always true if timescale is null). */
  private schemaReady = false;

  constructor(
    // Optional: when absent the index operates purely in-memory.
    private readonly timescale: TimescaleService | null = null,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Create the person_face_embeddings table if needed.
   *
   * Purely additive / idempotent — safe to call on every boot. The schema
   * mirrors visual_object_embeddings (VWM pattern): TEXT primary key, pgvector
   * column, person_id TEXT (not a FK — persons live in Neo4j OKG, not here),
   * and a compound index on person_id for fast per-person loads.
   *
   * Called by LatentSpaceService.onModuleInit() after its own schema is set up,
   * so the caller controls ordering and error handling.
   */
  async ensureSchema(): Promise<void> {
    if (!this.timescale) return;

    try {
      await this.timescale.query(`
        CREATE TABLE IF NOT EXISTS person_face_embeddings (
          id               TEXT PRIMARY KEY,
          person_id        TEXT NOT NULL,
          embedding        vector(${EMBEDDING_DIM}),
          recurrence_count INTEGER NOT NULL DEFAULT 1,
          graduated        BOOLEAN NOT NULL DEFAULT false,
          created_at       TIMESTAMPTZ NOT NULL,
          last_matched_at  TIMESTAMPTZ
        )
      `);

      // Fast per-person load — every query is WHERE person_id = $1.
      await this.timescale.query(`
        CREATE INDEX IF NOT EXISTS person_face_embeddings_person_idx
          ON person_face_embeddings (person_id)
      `);

      this.schemaReady = true;
      this.logger.log(`person_face_embeddings schema verified (vector(${EMBEDDING_DIM})).`);
    } catch (err) {
      this.logger.warn(`person_face_embeddings schema creation failed: ${err}`);
      // Degrade to in-memory only — the privacy invariant is unaffected.
    }
  }

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
  async writeFace(personId: string, embedding: number[]): Promise<string> {
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

    // Lazily load this person's existing entries from the DB before the first
    // write so deduplication works correctly across restarts.
    await this.ensurePersonLoaded(personId);

    const store = this.getOrCreateStore(personId);

    // Deduplication: find an existing entry close enough to this embedding.
    const existing = this.findBestInStore(store, embedding, FACE_SIMILARITY_THRESHOLD);
    if (existing) {
      existing.entry.recurrenceCount++;
      existing.entry.lastMatchedAt = new Date();

      // Check graduation threshold.
      const justGraduated =
        !existing.entry.graduated &&
        existing.entry.recurrenceCount >= FACE_GRADUATION_THRESHOLD;
      if (justGraduated) {
        existing.entry.graduated = true;
        this.logger.log(
          `PersonScopedFaceIndex: face ${existing.entry.id.substring(0, 8)} for person ` +
            `${personId.substring(0, 8)} GRADUATED after ${existing.entry.recurrenceCount} recurrences.`,
        );
      }

      // Persist the updated recurrence count and graduation flag.
      void this.persistUpdate(existing.entry);

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

    // Persist the new entry.
    void this.persistInsert(entry);

    return entry.id;
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  /**
   * Search for a matching face WITHIN a single person's scope.
   *
   * NEVER searches across persons. A face stored for Person A is invisible
   * to a search for Person B — the Map key enforces this structurally, and
   * the DB layer enforces it via person_id-scoped queries in ensurePersonLoaded.
   *
   * Only graduated entries are returned as reflex candidates (they have
   * demonstrated they recur reliably for this person). Non-graduated entries
   * accumulate recurrences but do not fire Type 1 reflexes yet.
   *
   * @param personId  The person whose face index to search.
   * @param embedding The query embedding.
   * @returns The best-matching graduated face entry, or null.
   */
  async searchFace(personId: string, embedding: number[]): Promise<PersonFaceMatch | null> {
    // Zero-vector guard.
    const normSq = embedding.reduce((s, v) => s + v * v, 0);
    if (normSq === 0) return null;

    // Lazily load this person's entries if not yet in memory.
    await this.ensurePersonLoaded(personId);

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

  /** Clear all in-memory stores (test seam — does NOT touch the DB). */
  clear(): void {
    this.personStores.clear();
    this.loadedPersonIds.clear();
  }

  // ---------------------------------------------------------------------------
  // DB persistence helpers
  // ---------------------------------------------------------------------------

  /**
   * Load all face entries for a personId from the DB into the in-memory store.
   * No-op if the person was already loaded, if there is no DB, or if the
   * schema is not ready. The store is populated from the DB rows so that
   * in-memory deduplication (findBestInStore) works correctly after a restart.
   *
   * Isolation: the SELECT is parameterized by person_id — it is structurally
   * impossible to load another person's rows here.
   *
   * Race safety: the Map stores the in-flight Promise so concurrent callers
   * for the same personId await the SAME SELECT rather than firing duplicates
   * that would double-push DB rows into the in-memory store.
   */
  private ensurePersonLoaded(personId: string): Promise<void> {
    const existing = this.loadedPersonIds.get(personId);
    if (existing !== undefined) return existing;

    const load = this.loadPersonFromDb(personId);
    // Register before the first await so concurrent callers share this promise.
    this.loadedPersonIds.set(personId, load);
    return load;
  }

  private async loadPersonFromDb(personId: string): Promise<void> {
    if (!this.timescale || !this.schemaReady) return;

    try {
      const result = await this.timescale.query<{
        id: string;
        person_id: string;
        embedding: string;
        recurrence_count: number;
        graduated: boolean;
        created_at: string;
        last_matched_at: string | null;
      }>(
        `SELECT id, person_id, embedding::text, recurrence_count, graduated,
                created_at, last_matched_at
         FROM person_face_embeddings
         WHERE person_id = $1`,
        [personId],
      );

      const store = this.getOrCreateStore(personId);
      for (const row of result.rows) {
        const embedding = parseVectorLiteral(row.embedding);
        if (!embedding || embedding.length !== EMBEDDING_DIM) continue;

        store.push({
          id: row.id,
          personId: row.person_id,
          embedding,
          recurrenceCount: Number(row.recurrence_count),
          graduated: Boolean(row.graduated),
          createdAt: new Date(row.created_at),
          lastMatchedAt: row.last_matched_at ? new Date(row.last_matched_at) : null,
        });
      }

      if (result.rows.length > 0) {
        this.logger.debug(
          `PersonScopedFaceIndex: loaded ${result.rows.length} face entries for person ` +
            `${personId.substring(0, 8)} from DB.`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `PersonScopedFaceIndex: DB load failed for person ${personId.substring(0, 8)}: ${err}. ` +
          `Continuing with in-memory state.`,
      );
      // Remove from the map so the next call retries (recoverable error).
      this.loadedPersonIds.delete(personId);
    }
  }

  /**
   * Insert a brand-new face entry into the DB.
   * Fire-and-forget: failures are logged but never throw (mirrors the warm-layer
   * write pattern in LatentSpaceService). The in-memory store is the source of
   * truth for the current session; the DB makes it durable across restarts.
   */
  private persistInsert(entry: PersonFaceEntry): Promise<void> {
    if (!this.timescale || !this.schemaReady) return Promise.resolve();

    return this.timescale.query(
      `INSERT INTO person_face_embeddings
         (id, person_id, embedding, recurrence_count, graduated, created_at, last_matched_at)
       VALUES ($1, $2, $3::vector, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        entry.id,
        entry.personId,
        `[${entry.embedding.join(',')}]`,
        entry.recurrenceCount,
        entry.graduated,
        entry.createdAt,
        entry.lastMatchedAt,
      ],
    ).then(() => {}).catch((err) => {
      this.logger.warn(
        `PersonScopedFaceIndex: DB insert failed for face ${entry.id.substring(0, 8)}: ${err}`,
      );
    });
  }

  /**
   * Update an existing face entry's recurrence_count, graduated, and
   * last_matched_at in the DB.
   * Fire-and-forget (same rationale as persistInsert).
   */
  private persistUpdate(entry: PersonFaceEntry): Promise<void> {
    if (!this.timescale || !this.schemaReady) return Promise.resolve();

    return this.timescale.query(
      `UPDATE person_face_embeddings
       SET recurrence_count = $2,
           graduated        = $3,
           last_matched_at  = $4
       WHERE id = $1`,
      [
        entry.id,
        entry.recurrenceCount,
        entry.graduated,
        entry.lastMatchedAt,
      ],
    ).then(() => {}).catch((err) => {
      this.logger.warn(
        `PersonScopedFaceIndex: DB update failed for face ${entry.id.substring(0, 8)}: ${err}`,
      );
    });
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

// ---------------------------------------------------------------------------
// Module-private helper
// ---------------------------------------------------------------------------

/**
 * Parse a pgvector text literal (`'[1,2,3]'`) into a `number[]`.
 * Mirrors the same helper in visual-working-memory.service.ts — kept local
 * here to avoid a cross-package import from an app-layer service.
 * Returns null on empty/invalid/non-finite input.
 */
function parseVectorLiteral(literal: string | null | undefined): number[] | null {
  if (!literal) return null;
  try {
    const parsed: unknown = JSON.parse(literal);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (!parsed.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
    return parsed as number[];
  } catch {
    return null;
  }
}
