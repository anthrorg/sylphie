/**
 * VoiceLatentSpaceService — TTS Bootstrap & Cache Architecture.
 *
 * Treats ElevenLabs as a bootstrap dependency, not a permanent one. Every
 * TTS-generated utterance is captured, encoded, and stored. Over time,
 * Type 1 retrieval from cached audio replaces live TTS calls.
 *
 * Three-layer architecture (mirrors semantic latent space):
 *   Hot layer  — In-memory: text hash → audio buffer. Microsecond lookup.
 *   Warm layer — TimescaleDB: voice_patterns table with pgvector. Survives reboot.
 *   Cold layer — Audio blobs (future: object storage). Full archival.
 *
 * The same Kahneman pattern: TTS is System 2 (slow, expensive), cached audio
 * is System 1 (instant, free). The slow path seeds the fast path.
 *
 * See: wiki/ideas/voice-latent-space.md for the full design.
 */

import { Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { TimescaleService, EMBEDDING_DIM } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A cached voice pattern. */
export interface VoicePattern {
  readonly id: string;
  readonly textContent: string;
  readonly textHash: string;
  readonly audioBase64: string;
  readonly audioFormat: string;
  readonly durationMs: number;
  readonly emotionalValence: number;
  readonly usageCount: number;
  readonly granularity: 'FULL_PHRASE' | 'SEGMENT' | 'PHONEME';
  readonly source: 'TTS_BOOTSTRAP' | 'SELF_GENERATED';
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

/** Result of a voice cache lookup. */
export interface VoiceCacheResult {
  readonly pattern: VoicePattern;
  readonly cacheHit: true;
}

// ---------------------------------------------------------------------------
// Hot Layer Entry (minimal footprint)
// ---------------------------------------------------------------------------

interface HotVoiceEntry {
  id: string;
  textHash: string;
  textContent: string;
  audioBase64: string;
  audioFormat: string;
  emotionalValence: number;
  usageCount: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Max entries in the hot layer. */
const MAX_HOT_ENTRIES = 500;

/** Valence difference threshold — if drive state differs more than this
 *  from the cached version, skip the cache (different emotional tone needed). */
const VALENCE_TOLERANCE = 0.3;

// ---------------------------------------------------------------------------
// VoiceLatentSpaceService
// ---------------------------------------------------------------------------

@Injectable()
export class VoiceLatentSpaceService implements OnModuleInit {
  private readonly logger = new Logger(VoiceLatentSpaceService.name);

  /** Hot layer — text hash → audio entry. */
  private readonly hotLayer = new Map<string, HotVoiceEntry>();

  /** Whether the warm layer schema is ready. */
  private schemaReady = false;

  constructor(
    private readonly timescale: TimescaleService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    await this.ensureSchema();
    if (this.schemaReady) {
      await this.hydrate();
    }
  }

  // ---------------------------------------------------------------------------
  // Lookup (Type 1 voice path)
  // ---------------------------------------------------------------------------

  /**
   * Look up cached audio for the given text and emotional valence.
   *
   * Uses text hash for exact match. If the emotional valence differs too
   * much from the cached version, returns null (the tone needs to be
   * different, so we need a fresh TTS call).
   *
   * @param text     - The text to speak.
   * @param valence  - Current emotional valence from drive engine [0.0, 1.0].
   * @returns Cached audio pattern, or null on miss.
   */
  lookup(text: string, valence: number): VoiceCacheResult | null {
    const hash = hashText(text);
    const entry = this.hotLayer.get(hash);

    if (!entry) {
      return null;
    }

    // Check emotional valence compatibility — same words said differently
    // under different emotional states should NOT be cached hits.
    if (Math.abs(entry.emotionalValence - valence) > VALENCE_TOLERANCE) {
      this.logger.debug(
        `Voice cache valence mismatch: cached=${entry.emotionalValence.toFixed(2)}, ` +
          `current=${valence.toFixed(2)} — regenerating TTS.`,
      );
      return null;
    }

    // Hit — update usage
    entry.usageCount++;
    this.updateUsage(entry.id);

    return {
      pattern: {
        id: entry.id,
        textContent: entry.textContent,
        textHash: entry.textHash,
        audioBase64: entry.audioBase64,
        audioFormat: entry.audioFormat,
        durationMs: 0, // Not tracked in hot layer
        emotionalValence: entry.emotionalValence,
        usageCount: entry.usageCount,
        granularity: 'FULL_PHRASE',
        source: 'TTS_BOOTSTRAP',
        createdAt: new Date(),
        lastUsedAt: new Date(),
      },
      cacheHit: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Store (capture TTS output)
  // ---------------------------------------------------------------------------

  /**
   * Store a TTS-generated audio clip in the voice latent space.
   *
   * Called by CommunicationService after every TTS call. The audio becomes
   * available for Type 1 retrieval immediately (hot layer) and persists
   * across restarts (warm layer).
   *
   * @param text         - The text that was spoken.
   * @param audioBase64  - Base64-encoded audio (MP3).
   * @param audioFormat  - MIME type (e.g., 'audio/mpeg').
   * @param valence      - Emotional valence at generation time.
   */
  async store(
    text: string,
    audioBase64: string,
    audioFormat: string,
    valence: number,
  ): Promise<void> {
    const hash = hashText(text);
    const id = randomUUID();

    // Add to hot layer
    const entry: HotVoiceEntry = {
      id,
      textHash: hash,
      textContent: text,
      audioBase64,
      audioFormat,
      emotionalValence: valence,
      usageCount: 0,
    };

    this.hotLayer.set(hash, entry);

    // Evict LRU if over capacity
    if (this.hotLayer.size > MAX_HOT_ENTRIES) {
      let lowestUse = Infinity;
      let lowestKey = '';
      for (const [key, e] of this.hotLayer) {
        if (e.usageCount < lowestUse) {
          lowestUse = e.usageCount;
          lowestKey = key;
        }
      }
      if (lowestKey) this.hotLayer.delete(lowestKey);
    }

    this.logger.debug(
      `Voice cache store: "${text.substring(0, 40)}..." (${audioBase64.length} b64 chars). ` +
        `Hot layer: ${this.hotLayer.size} patterns.`,
    );

    // Persist to warm layer (fire-and-forget)
    if (this.timescale && this.schemaReady) {
      this.timescale.query(
        `INSERT INTO voice_patterns
           (id, text_hash, text_content, audio_data, audio_format,
            emotional_valence, usage_count, granularity, source,
            created_at, last_used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (text_hash) DO UPDATE SET
           audio_data = $4,
           emotional_valence = $6,
           last_used_at = NOW()`,
        [
          id, hash, text, audioBase64, audioFormat,
          valence, 0, 'FULL_PHRASE', 'TTS_BOOTSTRAP',
          new Date(), null,
        ],
      ).catch((err) => {
        this.logger.warn(`Voice warm layer write failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  get hotLayerSize(): number {
    return this.hotLayer.size;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private updateUsage(patternId: string): void {
    if (this.timescale && this.schemaReady) {
      this.timescale.query(
        'UPDATE voice_patterns SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = $1',
        [patternId],
      ).catch(() => {});
    }
  }

  private async ensureSchema(): Promise<void> {
    if (!this.timescale) return;

    try {
      await this.timescale.query(`
        CREATE TABLE IF NOT EXISTS voice_patterns (
          id                UUID PRIMARY KEY,
          text_hash         TEXT NOT NULL UNIQUE,
          text_content      TEXT NOT NULL,
          audio_data        TEXT NOT NULL,
          audio_format      TEXT NOT NULL DEFAULT 'audio/mpeg',
          emotional_valence FLOAT DEFAULT 0,
          usage_count       INTEGER DEFAULT 0,
          granularity       TEXT DEFAULT 'FULL_PHRASE',
          source            TEXT DEFAULT 'TTS_BOOTSTRAP',
          created_at        TIMESTAMPTZ NOT NULL,
          last_used_at      TIMESTAMPTZ
        )
      `);

      await this.timescale.query(`
        CREATE INDEX IF NOT EXISTS voice_patterns_hash_idx ON voice_patterns (text_hash)
      `);

      await this.timescale.query(`
        CREATE INDEX IF NOT EXISTS voice_patterns_usage_idx
        ON voice_patterns (usage_count DESC, last_used_at DESC NULLS LAST)
      `);

      this.schemaReady = true;
      this.logger.log('voice_patterns schema verified.');
    } catch (err) {
      this.logger.error(`Voice schema creation failed: ${err instanceof Error ? err.message : String(err)}`);
      this.schemaReady = false;
    }
  }

  private async hydrate(): Promise<void> {
    if (!this.timescale || !this.schemaReady) return;

    try {
      const result = await this.timescale.query<{
        id: string;
        text_hash: string;
        text_content: string;
        audio_data: string;
        audio_format: string;
        emotional_valence: number;
        usage_count: number;
      }>(
        `SELECT id, text_hash, text_content, audio_data, audio_format,
                emotional_valence, usage_count
         FROM voice_patterns
         ORDER BY usage_count DESC, last_used_at DESC NULLS LAST
         LIMIT $1`,
        [MAX_HOT_ENTRIES],
      );

      for (const row of result.rows) {
        this.hotLayer.set(row.text_hash, {
          id: row.id,
          textHash: row.text_hash,
          textContent: row.text_content,
          audioBase64: row.audio_data,
          audioFormat: row.audio_format,
          emotionalValence: row.emotional_valence,
          usageCount: row.usage_count,
        });
      }

      this.logger.log(
        `Voice latent space hydrated: ${this.hotLayer.size} patterns loaded.`,
      );
    } catch (err) {
      this.logger.warn(`Voice hydration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hash text content for exact-match lookup. Normalizes whitespace and case. */
function hashText(text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex').substring(0, 16);
}
