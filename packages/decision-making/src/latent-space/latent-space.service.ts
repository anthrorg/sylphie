/**
 * LatentSpaceService — Per-modality pattern matching for Type 1 reflexes.
 *
 * The latent space bridges Type 2 deliberation and Type 1 reflexes. When
 * Type 2 commits a decision, it writes per-modality patterns here. Next time
 * a similar stimulus arrives on ANY modality, Type 1 finds the pattern via
 * cosine similarity and responds immediately — no LLM needed.
 *
 * Per-modality architecture:
 *   Patterns are stored per modality (text, audio, video, etc.). Search
 *   operates on each modality independently, then combines scores with
 *   weighted voting. This prevents stable modalities (video/audio) from
 *   drowning out text changes in the fused embedding.
 *
 * Three-layer architecture:
 *   Hot layer  — In-memory vector index. Microsecond cosine similarity.
 *   Warm layer — pgvector in TimescaleDB. Durable. Hydrated into hot on boot.
 *   Cold layer — Full deliberation traces in WKG (handled by WkgContextService).
 *
 * On boot: hydrate hot layer from warm layer (frequency-weighted).
 * On shutdown: hot layer is ephemeral — warm layer IS the persistence.
 */

import { Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TimescaleService, EMBEDDING_DIM, verboseFor } from '@sylphie/shared';

const vlog = verboseFor('Memory');
import { cosineSimilarity, parseEmbedding } from './vector-math';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A learned pattern stored in the latent space. */
export interface LearnedPattern {
  readonly id: string;
  readonly modality: string;
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

/** Result of a single-modality latent space search. */
export interface LatentMatch {
  readonly pattern: LearnedPattern;
  readonly similarity: number;
  readonly modality: string;
}

/** Result of a multi-modal latent space search. */
export interface MultiModalLatentMatch {
  /** Per-modality matches that passed threshold. */
  readonly matches: readonly LatentMatch[];
  /** The single highest-scoring match across all modalities. */
  readonly bestMatch: LatentMatch;
  /** Weighted combination of per-modality similarities. */
  readonly compositeSimilarity: number;
}

/** Parameters for writing a new pattern. */
export interface NewPattern {
  readonly modality: string;
  readonly stimulusEmbedding: number[];
  readonly responseText: string;
  readonly procedureId?: string;
  readonly confidence: number;
  readonly deliberationSummary?: string;
  readonly entityIds: readonly string[];
  readonly sessionId?: string;
}

/** Options for writeMultiModal (everything except per-modality fields). */
export type MultiModalWriteOpts = Omit<NewPattern, 'stimulusEmbedding' | 'responseText' | 'modality'>;

// ---------------------------------------------------------------------------
// Hot Layer Entry (minimal footprint for in-memory search)
// ---------------------------------------------------------------------------

interface HotEntry {
  id: string;
  modality: string;
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

/** Maximum patterns to load into the hot layer on boot (across all modalities). */
const MAX_HOT_ENTRIES = 6000;

/** Default similarity threshold for Type 1 matching. */
const DEFAULT_SIMILARITY_THRESHOLD = 0.80;

/** Modality weights for composite scoring. Text dominates to prevent drowning. */
const MODALITY_WEIGHTS: Record<string, number> = {
  text: 0.50,
  audio: 0.25,
  video: 0.25,
  faces: 0.15,
  drives: 0.10,
};

/** Default weight for unknown modalities. */
const DEFAULT_MODALITY_WEIGHT = 0.15;

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
    private readonly timescale: TimescaleService,
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
  // Search — Single modality (internal)
  // ---------------------------------------------------------------------------

  /**
   * Search the hot layer for patterns matching a specific modality.
   */
  searchByModality(
    modality: string,
    embedding: number[],
    threshold = DEFAULT_SIMILARITY_THRESHOLD,
  ): LatentMatch | null {
    let bestEntry: HotEntry | null = null;
    let bestSimilarity = -1;

    for (const entry of this.hotLayer) {
      if (entry.modality !== modality) continue;
      const sim = cosineSimilarity(embedding, entry.embedding);
      if (sim > bestSimilarity && sim >= threshold) {
        bestSimilarity = sim;
        bestEntry = entry;
      }
    }

    if (!bestEntry) {
      vlog('latent searchByModality MISS', { modality, threshold, hotLayerSize: this.hotLayer.length });
      return null;
    }

    vlog('latent searchByModality HIT', {
      modality,
      similarity: +bestSimilarity.toFixed(3),
      patternId: bestEntry.id.substring(0, 8),
      responsePreview: bestEntry.responseText.substring(0, 60),
    });

    return {
      pattern: this.hotEntryToPattern(bestEntry),
      similarity: bestSimilarity,
      modality,
    };
  }

  // ---------------------------------------------------------------------------
  // Search — Multi-modal (primary API)
  // ---------------------------------------------------------------------------

  /**
   * Search per-modality latent spaces and combine results.
   *
   * For each modality present in modalityEmbeddings, searches the hot layer
   * for that modality's patterns. Returns the best match weighted by modality
   * importance (text dominates). Returns null if no modality exceeds threshold.
   */
  searchMultiModal(
    modalityEmbeddings: Record<string, number[]>,
    threshold = DEFAULT_SIMILARITY_THRESHOLD,
  ): MultiModalLatentMatch | null {
    if (this.hotLayer.length === 0) return null;

    const matches: LatentMatch[] = [];

    for (const [modality, embedding] of Object.entries(modalityEmbeddings)) {
      const match = this.searchByModality(modality, embedding, threshold);
      if (match) {
        matches.push(match);
      }
    }

    if (matches.length === 0) return null;

    // Text match is required for a meaningful multi-modal hit.
    // If text was searched but didn't match, or if text was absent entirely
    // (self-initiated tick with no user input), audio/video/drive similarity
    // alone is not meaningful — it just replays stale latent space patterns.
    const textMatched = matches.some(m => m.modality === 'text');
    if (!textMatched) {
      this.logger.debug(
        'searchMultiModal: no text match — discarding audio/video matches.',
      );
      return null;
    }

    // Find best individual match
    const bestMatch = matches.reduce((best, m) =>
      m.similarity > best.similarity ? m : best,
    );

    // Compute weighted composite similarity
    let weightedSum = 0;
    let totalWeight = 0;
    for (const match of matches) {
      const weight = MODALITY_WEIGHTS[match.modality] ?? DEFAULT_MODALITY_WEIGHT;
      weightedSum += match.similarity * weight;
      totalWeight += weight;
    }
    const compositeSimilarity = totalWeight > 0 ? weightedSum / totalWeight : 0;

    this.logger.debug(
      `searchMultiModal: ${matches.length} modality matches, ` +
        `best=${bestMatch.modality}(${bestMatch.similarity.toFixed(3)}), ` +
        `composite=${compositeSimilarity.toFixed(3)}`,
    );

    return { matches, bestMatch, compositeSimilarity };
  }

  // ---------------------------------------------------------------------------
  // Legacy search (fused embedding — backward compat)
  // ---------------------------------------------------------------------------

  /**
   * Search using a fused embedding. Matches against 'fused' modality entries.
   * @deprecated Use searchMultiModal for per-modality matching.
   */
  search(embedding: number[], threshold = DEFAULT_SIMILARITY_THRESHOLD): LatentMatch | null {
    return this.searchByModality('fused', embedding, threshold);
  }

  // ---------------------------------------------------------------------------
  // Write — Single pattern
  // ---------------------------------------------------------------------------

  /**
   * Write a new learned pattern to both warm and hot layers.
   * @returns The ID of the created pattern, or '' if rejected.
   */
  async write(pattern: NewPattern): Promise<string> {
    if (!pattern.responseText || pattern.responseText.trim().length === 0) {
      vlog('latent write REJECTED', { modality: pattern.modality, reason: 'empty responseText' });
      this.logger.warn('Rejecting latent space write: responseText is empty.');
      return '';
    }

    const id = randomUUID();
    const now = new Date();

    this.hotLayer.push({
      id,
      modality: pattern.modality,
      embedding: pattern.stimulusEmbedding,
      responseText: pattern.responseText,
      procedureId: pattern.procedureId ?? null,
      confidence: pattern.confidence,
      useCount: 0,
      entityIds: [...pattern.entityIds],
    });

    vlog('latent write', {
      modality: pattern.modality,
      patternId: id.substring(0, 8),
      confidence: +pattern.confidence.toFixed(2),
      entityCount: pattern.entityIds.length,
      hotLayerSize: this.hotLayer.length,
      responsePreview: pattern.responseText.substring(0, 60),
    });

    this.logger.debug(
      `Latent space write [${pattern.modality}]: pattern ${id.substring(0, 8)} ` +
        `(confidence: ${pattern.confidence.toFixed(2)}, entities: ${pattern.entityIds.length}). ` +
        `Hot layer: ${this.hotLayer.length} patterns.`,
    );

    if (this.timescale && this.schemaReady) {
      const embeddingLiteral = `[${pattern.stimulusEmbedding.join(',')}]`;
      this.timescale.query(
        `INSERT INTO learned_patterns
           (id, modality, stimulus_embedding, response_text, procedure_id, confidence,
            use_count, recent_mae, deliberation_summary, entity_ids,
            created_at, last_used_at, session_id)
         VALUES ($1, $2, $3::vector, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          id,
          pattern.modality,
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
  // Write — Multi-modal (writes one entry per active modality)
  // ---------------------------------------------------------------------------

  /**
   * Write per-modality patterns for a single response.
   * Creates one entry per modality in modalityEmbeddings, all sharing
   * the same responseText and metadata.
   *
   * @returns Array of pattern IDs (one per modality written).
   */
  async writeMultiModal(
    modalityEmbeddings: Record<string, number[]>,
    responseText: string,
    opts: MultiModalWriteOpts,
  ): Promise<string[]> {
    const ids: string[] = [];

    for (const [modality, embedding] of Object.entries(modalityEmbeddings)) {
      // Skip drive/face modalities for now — they don't carry conversational signal
      if (modality === 'drives' || modality === 'faces') continue;

      const id = await this.write({
        modality,
        stimulusEmbedding: embedding,
        responseText,
        ...opts,
      });
      if (id) ids.push(id);
    }

    return ids;
  }

  // ---------------------------------------------------------------------------
  // Use tracking
  // ---------------------------------------------------------------------------

  /** Record that a pattern was used by Type 1. */
  recordUse(patternId: string): void {
    const entry = this.hotLayer.find((e) => e.id === patternId);
    if (entry) {
      entry.useCount++;
    }

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

  /** Update the confidence of a pattern (after outcome evaluation). */
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
  // Reset
  // ---------------------------------------------------------------------------

  /** Clear all learned patterns from both hot and warm layers. */
  async clear(): Promise<number> {
    const count = this.hotLayer.length;
    this.hotLayer = [];

    if (this.timescale && this.schemaReady) {
      await this.timescale.query('TRUNCATE learned_patterns');
    }

    this.logger.warn(`Latent space cleared: ${count} hot layer patterns removed, warm layer truncated.`);
    return count;
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
          modality            TEXT DEFAULT 'fused',
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

      // Add modality column if upgrading from old schema
      await this.timescale.query(`
        ALTER TABLE learned_patterns
        ADD COLUMN IF NOT EXISTS modality TEXT DEFAULT 'fused'
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

      await this.timescale.query(`
        CREATE INDEX IF NOT EXISTS learned_patterns_modality_idx
        ON learned_patterns (modality)
      `);

      this.schemaReady = true;
      this.logger.log('learned_patterns schema verified (pgvector + modality index ready)');
    } catch (err) {
      this.logger.error(
        `Latent space schema creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.schemaReady = false;
    }
  }

  /** Hydrate the hot layer from the warm layer on boot. */
  private async hydrate(): Promise<void> {
    if (!this.timescale || !this.schemaReady) return;

    try {
      const result = await this.timescale.query<{
        id: string;
        modality: string | null;
        stimulus_embedding: string;
        response_text: string;
        procedure_id: string | null;
        confidence: number;
        use_count: number;
        entity_ids: string[] | null;
      }>(
        `SELECT id, COALESCE(modality, 'fused') AS modality,
                stimulus_embedding::text, response_text, procedure_id,
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
            modality: row.modality ?? 'fused',
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

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private hotEntryToPattern(entry: HotEntry): LearnedPattern {
    return {
      id: entry.id,
      modality: entry.modality,
      stimulusEmbedding: entry.embedding,
      responseText: entry.responseText,
      procedureId: entry.procedureId,
      confidence: entry.confidence,
      useCount: entry.useCount,
      recentMae: 0,
      deliberationSummary: null,
      entityIds: entry.entityIds,
      createdAt: new Date(),
      lastUsedAt: null,
      sessionId: null,
    };
  }
}
