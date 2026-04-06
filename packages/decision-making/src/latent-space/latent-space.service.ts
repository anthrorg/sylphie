/**
 * LatentSpaceService — Fast pattern matching for Type 1 reflexes.
 *
 * The latent space bridges Type 2 deliberation and Type 1 reflexes. When
 * Type 2 commits a decision, it writes a pattern here. Next time a similar
 * stimulus arrives, Type 1 finds the pattern via cosine similarity and
 * responds immediately — no LLM needed.
 *
 * Three-layer architecture:
 *   Hot layer  — In-memory vector index. Microsecond cosine similarity.
 *   Warm layer — pgvector in TimescaleDB. Durable. Hydrated into hot on boot.
 *   Cold layer — Full deliberation traces in WKG (handled by WkgContextService).
 *
 * Patterns link to WKG entity IDs so Type 1 responses aren't just vector
 * matches — they carry grounded knowledge context.
 *
 * On boot: hydrate hot layer from warm layer (frequency-weighted).
 * On shutdown: hot layer is ephemeral — warm layer IS the persistence.
 */

import { Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TimescaleService, EMBEDDING_DIM } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A learned pattern stored in the latent space. */
export interface LearnedPattern {
  readonly id: string;
  readonly stimulusEmbedding: number[];
  readonly responseText: string;
  readonly procedureId: string | null;
  readonly confidence: number;
  readonly useCount: number;
  readonly recentMae: number;
  readonly deliberationSummary: string | null;
  readonly entityIds: readonly string[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly sessionId: string | null;
}

/** Result of a latent space search. */
export interface LatentMatch {
  readonly pattern: LearnedPattern;
  readonly similarity: number;
}

/** Parameters for writing a new pattern. */
export interface NewPattern {
  readonly stimulusEmbedding: number[];
  readonly responseText: string;
  readonly procedureId?: string;
  readonly confidence: number;
  readonly deliberationSummary?: string;
  readonly entityIds: readonly string[];
  readonly sessionId?: string;
}

// ---------------------------------------------------------------------------
// Hot Layer Entry (minimal footprint for in-memory search)
// ---------------------------------------------------------------------------

interface HotEntry {
  id: string;
  embedding: number[];
  responseText: string;
  procedureId: string | null;
  confidence: number;
  useCount: number;
  entityIds: string[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum patterns to load into the hot layer on boot. */
const MAX_HOT_ENTRIES = 2000;

/** Default similarity threshold for Type 1 matching. */
const DEFAULT_SIMILARITY_THRESHOLD = 0.80;

// ---------------------------------------------------------------------------
// LatentSpaceService
// ---------------------------------------------------------------------------

@Injectable()
export class LatentSpaceService implements OnModuleInit {
  private readonly logger = new Logger(LatentSpaceService.name);

  /** Hot layer — in-memory for fast cosine similarity. */
  private hotLayer: HotEntry[] = [];

  /** Whether the warm layer schema has been created. */
  private schemaReady = false;

  constructor(
    @Optional() private readonly timescale: TimescaleService | null,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    if (!this.timescale) {
      this.logger.warn('TimescaleService unavailable — latent space will be in-memory only (not persisted).');
      return;
    }

    await this.ensureSchema();
    if (this.schemaReady) {
      await this.hydrate();
    }
  }

  // ---------------------------------------------------------------------------
  // Search (Type 1 path)
  // ---------------------------------------------------------------------------

  /**
   * Search the hot layer for a pattern matching the given embedding.
   *
   * Returns the best match above the similarity threshold, or null if
   * no pattern is similar enough. This is the Type 1 "reflex" path —
   * called before arbitration to check if we already know what to do.
   *
   * @param embedding  - The fused sensory embedding from the current frame.
   * @param threshold  - Minimum cosine similarity. Defaults to 0.80.
   * @returns The best matching pattern with similarity score, or null.
   */
  search(embedding: number[], threshold = DEFAULT_SIMILARITY_THRESHOLD): LatentMatch | null {
    if (this.hotLayer.length === 0) {
      return null;
    }

    let bestEntry: HotEntry | null = null;
    let bestSimilarity = -1;

    for (const entry of this.hotLayer) {
      const sim = cosineSimilarity(embedding, entry.embedding);
      if (sim > bestSimilarity && sim >= threshold) {
        bestSimilarity = sim;
        bestEntry = entry;
      }
    }

    if (!bestEntry) {
      return null;
    }

    return {
      pattern: {
        id: bestEntry.id,
        stimulusEmbedding: bestEntry.embedding,
        responseText: bestEntry.responseText,
        procedureId: bestEntry.procedureId,
        confidence: bestEntry.confidence,
        useCount: bestEntry.useCount,
        recentMae: 0,
        deliberationSummary: null,
        entityIds: bestEntry.entityIds,
        createdAt: new Date(),
        lastUsedAt: null,
        sessionId: null,
      },
      similarity: bestSimilarity,
    };
  }

  // ---------------------------------------------------------------------------
  // Write (Type 2 write-back)
  // ---------------------------------------------------------------------------

  /**
   * Write a new learned pattern to both warm and hot layers.
   *
   * Called after Type 2 deliberation commits a decision. The pattern
   * becomes available for Type 1 matching immediately (hot layer) and
   * persists across restarts (warm layer).
   *
   * @returns The ID of the created pattern.
   */
  async write(pattern: NewPattern): Promise<string> {
    const id = randomUUID();
    const now = new Date();

    // Add to hot layer immediately
    this.hotLayer.push({
      id,
      embedding: pattern.stimulusEmbedding,
      responseText: pattern.responseText,
      procedureId: pattern.procedureId ?? null,
      confidence: pattern.confidence,
      useCount: 0,
      entityIds: [...pattern.entityIds],
    });

    this.logger.debug(
      `Latent space write: pattern ${id.substring(0, 8)} ` +
        `(confidence: ${pattern.confidence.toFixed(2)}, entities: ${pattern.entityIds.length}). ` +
        `Hot layer: ${this.hotLayer.length} patterns.`,
    );

    // Persist to warm layer (fire-and-forget)
    if (this.timescale && this.schemaReady) {
      const embeddingLiteral = `[${pattern.stimulusEmbedding.join(',')}]`;
      this.timescale.query(
        `INSERT INTO learned_patterns
           (id, stimulus_embedding, response_text, procedure_id, confidence,
            use_count, recent_mae, deliberation_summary, entity_ids,
            created_at, last_used_at, session_id)
         VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          embeddingLiteral,
          pattern.responseText,
          pattern.procedureId ?? null,
          pattern.confidence,
          0,
          0,
          pattern.deliberationSummary ?? null,
          pattern.entityIds,
          now,
          null,
          pattern.sessionId ?? null,
        ],
      ).catch((err) => {
        this.logger.warn(`Warm layer write failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    return id;
  }

  // ---------------------------------------------------------------------------
  // Use tracking
  // ---------------------------------------------------------------------------

  /**
   * Record that a pattern was used by Type 1.
   * Updates use_count and last_used_at in both layers.
   */
  recordUse(patternId: string): void {
    // Update hot layer
    const entry = this.hotLayer.find((e) => e.id === patternId);
    if (entry) {
      entry.useCount++;
    }

    // Update warm layer (fire-and-forget)
    if (this.timescale && this.schemaReady) {
      this.timescale.query(
        `UPDATE learned_patterns
         SET use_count = use_count + 1, last_used_at = NOW()
         WHERE id = $1`,
        [patternId],
      ).catch((err) => {
        this.logger.warn(`Use tracking update failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  /**
   * Update the confidence of a pattern (after outcome evaluation).
   */
  updateConfidence(patternId: string, newConfidence: number): void {
    const entry = this.hotLayer.find((e) => e.id === patternId);
    if (entry) {
      entry.confidence = newConfidence;
    }

    if (this.timescale && this.schemaReady) {
      this.timescale.query(
        `UPDATE learned_patterns SET confidence = $1 WHERE id = $2`,
        [newConfidence, patternId],
      ).catch((err) => {
        this.logger.warn(`Confidence update failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  /** Number of patterns in the hot layer. */
  get hotLayerSize(): number {
    return this.hotLayer.length;
  }

  // ---------------------------------------------------------------------------
  // Schema & Hydration
  // ---------------------------------------------------------------------------

  /** Create the learned_patterns table and vector index if needed. */
  private async ensureSchema(): Promise<void> {
    if (!this.timescale) return;

    try {
      await this.timescale.query('CREATE EXTENSION IF NOT EXISTS vector');

      await this.timescale.query(`
        CREATE TABLE IF NOT EXISTS learned_patterns (
          id                  UUID PRIMARY KEY,
          stimulus_embedding  vector(${EMBEDDING_DIM}),
          response_text       TEXT NOT NULL,
          procedure_id        TEXT,
          confidence          FLOAT NOT NULL,
          use_count           INTEGER DEFAULT 0,
          recent_mae          FLOAT DEFAULT 0,
          deliberation_summary TEXT,
          entity_ids          TEXT[],
          created_at          TIMESTAMPTZ NOT NULL,
          last_used_at        TIMESTAMPTZ,
          session_id          TEXT
        )
      `);

      await this.timescale.query(`
        CREATE INDEX IF NOT EXISTS learned_patterns_embedding_idx
        ON learned_patterns
        USING ivfflat (stimulus_embedding vector_cosine_ops)
        WITH (lists = 100)
      `);

      await this.timescale.query(`
        CREATE INDEX IF NOT EXISTS learned_patterns_use_count_idx
        ON learned_patterns (use_count DESC, last_used_at DESC NULLS LAST)
      `);

      this.schemaReady = true;
      this.logger.log('learned_patterns schema verified (pgvector index ready)');
    } catch (err) {
      this.logger.error(
        `Latent space schema creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.schemaReady = false;
    }
  }

  /**
   * Hydrate the hot layer from the warm layer on boot.
   * Loads the most frequently used patterns first.
   */
  private async hydrate(): Promise<void> {
    if (!this.timescale || !this.schemaReady) return;

    try {
      const result = await this.timescale.query<{
        id: string;
        stimulus_embedding: string;
        response_text: string;
        procedure_id: string | null;
        confidence: number;
        use_count: number;
        entity_ids: string[] | null;
      }>(
        `SELECT id, stimulus_embedding::text, response_text, procedure_id,
                confidence, use_count, entity_ids
         FROM learned_patterns
         ORDER BY use_count DESC, last_used_at DESC NULLS LAST
         LIMIT $1`,
        [MAX_HOT_ENTRIES],
      );

      for (const row of result.rows) {
        const embedding = parseEmbedding(row.stimulus_embedding);
        if (embedding.length === EMBEDDING_DIM) {
          this.hotLayer.push({
            id: row.id,
            embedding,
            responseText: row.response_text,
            procedureId: row.procedure_id,
            confidence: row.confidence,
            useCount: row.use_count,
            entityIds: row.entity_ids ?? [],
          });
        }
      }

      this.logger.log(
        `Latent space hydrated: ${this.hotLayer.length} patterns loaded into hot layer ` +
          `(${result.rowCount} total in warm layer).`,
      );
    } catch (err) {
      this.logger.warn(
        `Latent space hydration failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Starting with empty hot layer.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Pure math helpers
// ---------------------------------------------------------------------------

/** Cosine similarity between two vectors. Returns value in [-1, 1]. */
function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Parse a pgvector text representation "[0.1,0.2,...]" into a number array. */
function parseEmbedding(text: string): number[] {
  if (!text || text.length < 3) return [];
  const inner = text.startsWith('[') ? text.slice(1, -1) : text;
  return inner.split(',').map(Number);
}
