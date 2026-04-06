/**
 * SensoryStreamLogger — Persists every sampled SensoryFrame to TimescaleDB.
 *
 * Middleware on the executor engine's tick path. After each sample(), the
 * encoded frame (fused embedding, modality embeddings, active modalities,
 * raw data summary, and the drive snapshot at tick time) is written to the
 * `sensory_ticks` hypertable.
 *
 * This serves two purposes:
 *
 * 1. **Audit trail**: Complete record of what Sylphie perceived, when, and
 *    in what motivational state. Required for post-hoc analysis, debugging,
 *    and the Learning subsystem's maintenance cycles.
 *
 * 2. **Vector search**: The fused_embedding column (vector(768)) supports
 *    pgvector cosine similarity queries. The action retriever and episodic
 *    memory can find similar past contexts via real embedding distance
 *    instead of Jaccard on text tokens.
 *
 * Schema (created by ensureSchema on first use):
 *
 *   sensory_ticks (
 *     time            TIMESTAMPTZ NOT NULL,
 *     session_id      TEXT NOT NULL,
 *     fused_embedding vector(768),
 *     active_modalities TEXT[],
 *     raw_summary     JSONB,
 *     drive_snapshot  JSONB,
 *     cycle_id        TEXT,
 *     tick_number     INTEGER
 *   )
 *
 * The table is converted to a TimescaleDB hypertable partitioned on `time`.
 * A pgvector ivfflat index is created on fused_embedding for approximate
 * nearest-neighbor queries.
 *
 * Writes are fire-and-forget — logging failures must never block the
 * executor's decision cycle.
 */

import { Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { TimescaleService, EMBEDDING_DIM, type SensoryFrame, type DriveSnapshot } from '@sylphie/shared';

@Injectable()
export class SensoryStreamLoggerService implements OnModuleInit {
  private readonly logger = new Logger(SensoryStreamLoggerService.name);
  private schemaReady = false;

  constructor(
    @Optional() private readonly timescale: TimescaleService | null,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.timescale) {
      await this.ensureSchema();
    } else {
      this.logger.warn('TimescaleService unavailable — sensory stream will not be persisted.');
    }
  }

  /**
   * Persist a sampled SensoryFrame to the sensory_ticks table.
   *
   * Fire-and-forget: errors are logged but never thrown. The executor's
   * decision cycle must not be blocked by storage failures.
   *
   * @param frame         - The sampled SensoryFrame (with EWMA-blended embedding).
   * @param driveSnapshot - Drive state at tick time.
   * @param sessionId     - Current session identifier.
   * @param cycleId       - Optional cycle correlation ID.
   */
  logFrame(
    frame: SensoryFrame,
    driveSnapshot: DriveSnapshot,
    sessionId: string,
    cycleId?: string,
  ): void {
    if (!this.timescale || !this.schemaReady) {
      return;
    }

    // Build a compact raw summary — full raw data may be large (video frames,
    // audio buffers). Store only metadata: modality names, text content (if
    // present), detection counts, etc.
    const rawSummary: Record<string, unknown> = {};
    for (const modality of frame.active_modalities) {
      const raw = frame.raw[modality];
      if (modality === 'text') {
        rawSummary.text = typeof raw === 'string' ? raw : (raw as any)?.content ?? null;
      } else if (modality === 'video') {
        const detections = (raw as any)?.detections ?? raw;
        rawSummary.video_detection_count = Array.isArray(detections) ? detections.length : 0;
      } else if (modality === 'audio') {
        rawSummary.audio_present = true;
      } else if (modality === 'drives') {
        rawSummary.drives_present = true;
      } else {
        rawSummary[modality] = 'present';
      }
    }

    // Format embedding as pgvector literal: [0.1,0.2,...]
    const embeddingLiteral = `[${frame.fused_embedding.join(',')}]`;

    this.timescale.query(
      `INSERT INTO sensory_ticks
         (time, session_id, fused_embedding, active_modalities, raw_summary,
          drive_snapshot, cycle_id, tick_number)
       VALUES ($1, $2, $3::vector, $4, $5, $6, $7, $8)`,
      [
        new Date(frame.timestamp),
        sessionId,
        embeddingLiteral,
        frame.active_modalities,
        JSON.stringify(rawSummary),
        JSON.stringify(driveSnapshot),
        cycleId ?? null,
        driveSnapshot.tickNumber,
      ],
    ).catch((err) => {
      this.logger.warn(`Failed to log sensory tick: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Query similar past sensory contexts by embedding cosine similarity.
   *
   * Uses pgvector's <=> operator for approximate nearest-neighbor search
   * on the ivfflat index. Returns the top-K most similar past frames.
   *
   * @param embedding - Query embedding vector (768-dim).
   * @param limit     - Maximum results. Defaults to 5.
   * @param sessionId - Optional: restrict search to a specific session.
   * @returns Array of { time, session_id, raw_summary, similarity } records.
   */
  async querySimilar(
    embedding: number[],
    limit = 5,
    sessionId?: string,
  ): Promise<Array<{ time: Date; session_id: string; raw_summary: unknown; similarity: number }>> {
    if (!this.timescale || !this.schemaReady) {
      return [];
    }

    const embeddingLiteral = `[${embedding.join(',')}]`;

    const sessionFilter = sessionId
      ? 'AND session_id = $3'
      : '';
    const params: unknown[] = [embeddingLiteral, limit];
    if (sessionId) params.push(sessionId);

    try {
      const result = await this.timescale.query<{
        time: Date;
        session_id: string;
        raw_summary: unknown;
        similarity: number;
      }>(
        `SELECT time, session_id, raw_summary,
                1 - (fused_embedding <=> $1::vector) AS similarity
         FROM sensory_ticks
         WHERE fused_embedding IS NOT NULL ${sessionFilter}
         ORDER BY fused_embedding <=> $1::vector
         LIMIT $2`,
        params,
      );
      return result.rows;
    } catch (err) {
      this.logger.warn(`Vector similarity query failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Create the sensory_ticks table, hypertable, and vector index if they
   * don't already exist.
   */
  private async ensureSchema(): Promise<void> {
    if (!this.timescale) return;

    try {
      // Enable pgvector extension (idempotent).
      await this.timescale.query('CREATE EXTENSION IF NOT EXISTS vector');

      // Create the table if it doesn't exist.
      await this.timescale.query(`
        CREATE TABLE IF NOT EXISTS sensory_ticks (
          time              TIMESTAMPTZ       NOT NULL,
          session_id        TEXT               NOT NULL,
          fused_embedding   vector(${EMBEDDING_DIM}),
          active_modalities TEXT[],
          raw_summary       JSONB,
          drive_snapshot    JSONB,
          cycle_id          TEXT,
          tick_number       INTEGER
        )
      `);

      // Convert to hypertable (idempotent — will no-op if already a hypertable).
      await this.timescale.query(`
        SELECT create_hypertable('sensory_ticks', 'time',
          if_not_exists => TRUE,
          migrate_data  => TRUE
        )
      `);

      // Create ivfflat vector index for approximate nearest-neighbor queries.
      // lists=100 is reasonable for up to ~1M rows. Will need tuning at scale.
      await this.timescale.query(`
        CREATE INDEX IF NOT EXISTS sensory_ticks_embedding_idx
        ON sensory_ticks
        USING ivfflat (fused_embedding vector_cosine_ops)
        WITH (lists = 100)
      `);

      // Create session + time index for filtered queries.
      await this.timescale.query(`
        CREATE INDEX IF NOT EXISTS sensory_ticks_session_time_idx
        ON sensory_ticks (session_id, time DESC)
      `);

      this.schemaReady = true;
      this.logger.log('sensory_ticks schema verified (hypertable + pgvector index)');
    } catch (err) {
      this.logger.error(
        `Failed to ensure sensory_ticks schema: ${err instanceof Error ? err.message : String(err)}. ` +
          `Stream logging will be disabled.`,
      );
      this.schemaReady = false;
    }
  }
}
