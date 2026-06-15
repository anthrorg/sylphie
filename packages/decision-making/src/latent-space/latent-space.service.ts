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

import { Injectable, Logger, Optional, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TimescaleService, EMBEDDING_DIM, verboseFor, type KnowledgeGrounding } from '@sylphie/shared';

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
  /**
   * The knowledge grounding recorded at write time, derived from the response
   * that produced this pattern. Used by groundingForCachedPattern() to replay
   * the same honest grounding verdict when this pattern fires as a Type 1 reflex.
   * Optional for backward compatibility with patterns written before this field
   * existed (those fall back to the entityIds heuristic in groundingForCachedPattern).
   */
  readonly knowledgeGrounding: KnowledgeGrounding | null;
  /**
   * WS4 Ticket 5 (§3.1) — whose OKG backs a GROUNDED claim from this pattern.
   *   null     = world-scoped (WKG-grounded, or non-GROUNDED); may replay GROUNDED
   *              to anyone.
   *   non-null = OKG-scoped to that personId; replaying GROUNDED to a DIFFERENT
   *              person is demoted to UNKNOWN at the latent-replay check
   *              (decision-making.service.ts), so person A's private fact never
   *              grounds person B's question.
   * Legacy rows are NULL (world-scoped) — deliberate; see ensureSchema() comment.
   */
  readonly groundingPersonId: string | null;
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
  /**
   * The knowledge grounding verdict to persist with the pattern so it can be
   * replayed honestly when this pattern fires as a Type 1 reflex, without
   * re-running the WKG/OKG attribution logic. Optional: omitting it causes
   * groundingForCachedPattern to fall back to the entityIds heuristic.
   */
  readonly knowledgeGrounding?: KnowledgeGrounding;
  /**
   * WS4 Ticket 5 (§3.1) — person scope for a GROUNDED claim. Optional; defaults
   * to null (world-scoped). Set to the current speaker's personId when the
   * GROUNDED verdict could not be PROVEN WKG-backed (the conservative rule).
   */
  readonly groundingPersonId?: string | null;
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
  knowledgeGrounding: KnowledgeGrounding | null;
  /** WS4 Ticket 5 (§3.1) — person scope; null = world-scoped. */
  groundingPersonId: string | null;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum patterns to load into the hot layer on boot (across all modalities). */
const MAX_HOT_ENTRIES = 6000;

/** Default similarity threshold for Type 1 matching. */
const DEFAULT_SIMILARITY_THRESHOLD = 0.80;

/**
 * P1 #0 — `visual_embedding` per-modality similarity threshold (PROVISIONAL).
 *
 * Deliberately NOT silently defaulted to 0.80: the visual_embedding modality is
 * a JL-projected, L2-normalized appearance vector whose cosine geometry differs
 * from the text/audio nomic spaces, so its accept threshold must be set from the
 * LIVE cosine-histogram measurement (mug-vs-book intra-modality cosine; two
 * different-COCO scenes), NOT inherited from the text default. Marked provisional
 * so the measurement phase replaces it.
 */
// cortex-set (2026-06-14, live measurement): conservative — sits above every
// observed off-target cosine (max 0.563 on real EfficientNet features) so it
// never false-merges. The true instance-re-id knee is UNMEASURABLE on
// EfficientNet classifier features (same-class bands overlap); residual is a
// mug/book/desk same-instance capture, falling to the P3 DINOv2 swap if those
// features still overlap. Conservative-high = safe failure direction (miss → fall
// to deliberation, never a confabulated merge).
const VISUAL_EMBEDDING_SIMILARITY_THRESHOLD = 0.80;

/**
 * Per-modality similarity thresholds for searchByModality. A modality NOT listed
 * here falls back to DEFAULT_SIMILARITY_THRESHOLD (0.80) — so every existing
 * modality is byte-for-byte unchanged. visual_embedding has an EXPLICIT entry
 * (its named provisional const) so it is never silently inheriting the text
 * default; the live measurement sets its final value.
 */
const MODALITY_SIMILARITY_THRESHOLDS: Record<string, number> = {
  visual_embedding: VISUAL_EMBEDDING_SIMILARITY_THRESHOLD,
};

/**
 * Minimum margin by which the best match must beat the SECOND-best match to be
 * accepted as a Type 1 reflex.
 *
 * Without a runner-up margin, a single over-general pattern can blanket every
 * input: as long as it (barely) clears the threshold it wins, even when many
 * other patterns score nearly identically — a signature of "matches everything"
 * rather than "matches this". Requiring the winner to stand out from the field
 * means a genuine, specific reflex (which dominates its neighbours) still fires,
 * while a diffuse over-general pattern (tied with the pack) is rejected and the
 * input falls through to honest deliberation / SHRUG.
 */
const RUNNER_UP_MARGIN = 0.05;

/**
 * MIN-POPULATION TRUST GATE (WS1 follow-up #3 — production hardening).
 *
 * The runner-up margin (above) only defends when there are ≥2 candidates of a
 * modality to discriminate against. The dangerous case it CANNOT see is a hot
 * layer holding exactly ONE pattern for a modality: with no runner-up, the margin
 * check is trivially satisfied, so a single over-general pattern fires a confident
 * GROUNDED Type 1 reflex against ANY input that grazes the 0.80 threshold. This is
 * the exact confabulation mechanism the gate exists to prevent: on a fresh boot (or
 * after the hot layer re-accumulates a single over-general pattern), nonsense gets
 * a trusted reflex and the honest ~6% autonomy number silently re-inflates.
 *
 * The gate: when a modality's hot layer is below MIN_MODALITY_POPULATION patterns,
 * a single-pattern match is only trusted if THAT pattern has earned trust through
 * repeated confirmed use (useCount ≥ MIN_TRUSTED_USECOUNT). A specific, battle-
 * tested reflex (used many times, confidence reinforced) still fires; a fresh,
 * unproven, over-general pattern is rejected and the input falls through to honest
 * deliberation. Once the layer holds ≥ MIN_MODALITY_POPULATION patterns, the
 * runner-up margin is doing real discrimination work and the population floor lifts.
 *
 * Standard 1 (provenance) / Standard 4 (theater prohibition): a reflex that fires
 * GROUNDED on nonsense is confabulation. This gate is the structural guarantee that
 * a single unproven pattern cannot manufacture trust it has not earned.
 */
const MIN_MODALITY_POPULATION = 3;

/**
 * useCount a SINGLE pattern must reach to be trusted when its modality's hot layer
 * is below MIN_MODALITY_POPULATION. A pattern that has fired and been confirmed
 * this many times is no longer "an untested over-general guess" — it has a track
 * record. Fresh patterns (useCount 0) never clear this floor, so a fresh-boot
 * single over-general pattern routes to deliberation, not a confident reflex.
 */
const MIN_TRUSTED_USECOUNT = 3;

/**
 * STANDARD 3 WRITE-TIME CONFIDENCE CEILING (CANON Immutable Standard 3).
 *
 * No node may exceed this confidence without a successful retrieval-and-use. A
 * freshly-written pattern has useCount 0 — it has been proposed but never proven —
 * so its confidence is hard-capped here at write time and in updateConfidence()
 * until useCount > 0. Guardian-sourced knowledge STARTS at this value (guardian
 * confirmation raises the *base*, it never lifts the ceiling); there is therefore
 * NO guardian/provenance bypass at useCount 0. Once useCount > 0, the legitimate
 * reinforced path (WS3 `max(current, min(0.60, recomputed))` discipline) governs,
 * and confidence may rise above the ceiling only through earned, used reinforcement.
 *
 * STANDARD 6 (No self-modification of evaluation): this is a compile-time constant
 * and the useCount rule is a compile-time guard. Neither is data-driven or learnable.
 * Do NOT make this configurable, schema-sourced, or adjustable at runtime.
 */
const WRITE_TIME_CONFIDENCE_CEILING = 0.6;

/** Modality weights for composite scoring. Text dominates to prevent drowning. */
const MODALITY_WEIGHTS: Record<string, number> = {
  text: 0.50,
  audio: 0.25,
  video: 0.25,
  faces: 0.15,
  drives: 0.10,
  // P1 #0 — visual_embedding composite weight. cortex-set (2026-06-14, live
  // measurement) to the floor (0.15): EfficientNet classifier-feature cosines are
  // noisy and class-overlapping, so visual_embedding is a tie-breaker on a
  // text-anchored multimodal hit, not a driver. Revisit after the P3 DINOv2 swap.
  visual_embedding: 0.15,
};

/** Default weight for unknown modalities. */
const DEFAULT_MODALITY_WEIGHT = 0.15;

// ---------------------------------------------------------------------------
// LatentSpaceService
// ---------------------------------------------------------------------------

@Injectable()
export class LatentSpaceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LatentSpaceService.name);

  /** Hot layer — in-memory for fast cosine similarity. */
  private hotLayer: HotEntry[] = [];

  /** Whether the warm layer schema has been created. */
  private schemaReady = false;

  /** Track pending warm-layer writes so we can flush on shutdown. */
  private pendingWrites: Promise<void>[] = [];

  /**
   * Wave 3 / C6 — audit counter for modality writes intentionally dropped by
   * writeMultiModal (drives/faces). These modalities are NOT written to the
   * shared conversational latent index yet: faces carry identity/privacy weight
   * (CANON Std-3) and want a separate person-scoped index, which is deferred to
   * a later wave (Jim's decision, 2026-06-15). Until then the drop is honest and
   * audited rather than silent (Std-1 — no silent stubs). A dedicated index, not
   * an unconditional skip, is the end state.
   */
  private readonly droppedModalityWrites = new Map<string, number>();

  constructor(
    private readonly timescale: TimescaleService,
  ) {}

  /**
   * Flush all pending warm-layer writes on shutdown.
   * Prevents pattern loss from unawaited fire-and-forget writes.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.pendingWrites.length > 0) {
      this.logger.log(`Flushing ${this.pendingWrites.length} pending warm-layer writes...`);
      await Promise.allSettled(this.pendingWrites);
      this.pendingWrites = [];
      this.logger.log('Warm-layer writes flushed.');
    }
  }

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
    threshold?: number,
  ): LatentMatch | null {
    // P1 #0 — resolve the effective accept threshold: an explicit caller value
    // wins; otherwise the per-modality threshold (MODALITY_SIMILARITY_THRESHOLDS)
    // applies; otherwise DEFAULT_SIMILARITY_THRESHOLD (0.80). Every existing
    // modality is absent from the map → falls back to 0.80, so passing nothing
    // is byte-for-byte unchanged for them. visual_embedding uses its named
    // provisional const instead of silently inheriting the text default.
    const effectiveThreshold =
      threshold ?? MODALITY_SIMILARITY_THRESHOLDS[modality] ?? DEFAULT_SIMILARITY_THRESHOLD;

    // Zero-vector guard: a zero embedding (cassette synthetic fallback, encoder
    // failure) has no semantic content. cosineSimilarity returns 0 for any
    // dot product against it, so it would never exceed 0.80 anyway — but
    // guarding explicitly here makes the invariant visible and prevents any
    // future refactoring from introducing NaN/1.0 via a different math path.
    const normSq = embedding.reduce((s, v) => s + v * v, 0);
    if (normSq === 0) {
      vlog('latent searchByModality MISS (zero-vector input — no semantic content)', { modality });
      return null;
    }

    let bestEntry: HotEntry | null = null;
    let bestSimilarity = -1;
    // Highest similarity among entries OTHER than the current best. A genuine
    // reflex must clear the threshold AND beat this runner-up by RUNNER_UP_MARGIN.
    let secondSimilarity = -1;
    // Population of THIS modality in the hot layer — feeds the min-population gate.
    let modalityPopulation = 0;

    for (const entry of this.hotLayer) {
      if (entry.modality !== modality) continue;
      modalityPopulation++;
      const sim = cosineSimilarity(embedding, entry.embedding);
      if (sim > bestSimilarity) {
        // Previous best becomes the runner-up.
        secondSimilarity = bestSimilarity;
        bestSimilarity = sim;
        bestEntry = entry;
      } else if (sim > secondSimilarity) {
        secondSimilarity = sim;
      }
    }

    if (!bestEntry || bestSimilarity < effectiveThreshold) {
      vlog('latent searchByModality MISS', { modality, threshold: effectiveThreshold, hotLayerSize: this.hotLayer.length });
      return null;
    }

    // MIN-POPULATION TRUST GATE — the structural defense against a single
    // over-general pattern firing a confident GROUNDED reflex on a fresh boot.
    //
    // When this modality's hot layer is sparse (< MIN_MODALITY_POPULATION), the
    // runner-up margin below has nothing to discriminate against (a lone pattern
    // has no runner-up, so the margin is trivially satisfied). In that regime we
    // require the matched pattern itself to have EARNED trust via repeated
    // confirmed use (useCount ≥ MIN_TRUSTED_USECOUNT). A fresh, unproven pattern
    // (useCount 0) is rejected → the input falls through to honest deliberation
    // instead of a confabulated reflex. Once the layer is populous enough, the
    // runner-up margin is the active discriminator and this floor lifts.
    if (
      modalityPopulation < MIN_MODALITY_POPULATION &&
      bestEntry.useCount < MIN_TRUSTED_USECOUNT
    ) {
      vlog('latent searchByModality MISS (min-population trust gate)', {
        modality,
        modalityPopulation,
        minPopulation: MIN_MODALITY_POPULATION,
        patternUseCount: bestEntry.useCount,
        minUseCount: MIN_TRUSTED_USECOUNT,
        best: +bestSimilarity.toFixed(3),
        patternId: bestEntry.id.substring(0, 8),
      });
      return null;
    }

    // Runner-up margin: reject an over-general pattern that wins by a hair over
    // a crowded field. A negative secondSimilarity means there was no runner-up
    // (only one candidate of this modality), which trivially satisfies the margin.
    if (secondSimilarity >= 0 && bestSimilarity - secondSimilarity < RUNNER_UP_MARGIN) {
      vlog('latent searchByModality MISS (runner-up margin)', {
        modality,
        best: +bestSimilarity.toFixed(3),
        second: +secondSimilarity.toFixed(3),
        margin: RUNNER_UP_MARGIN,
      });
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
    threshold?: number,
  ): MultiModalLatentMatch | null {
    if (this.hotLayer.length === 0) return null;

    const matches: LatentMatch[] = [];

    for (const [modality, embedding] of Object.entries(modalityEmbeddings)) {
      // P1 #0 — pass threshold through; when the caller omits it, searchByModality
      // resolves the PER-MODALITY threshold (visual_embedding gets its provisional
      // const; every other modality falls back to DEFAULT_SIMILARITY_THRESHOLD).
      const match = this.searchByModality(modality, embedding, threshold);
      if (match) {
        matches.push(match);
      }
    }

    if (matches.length === 0) return null;

    // Recall gate (P1.5 — cortex-ratified). The original rule REQUIRED a text
    // match, so a vision-only frame (no user text) could never recall a scene —
    // even though writeMultiModal persists a visual_embedding pattern for it.
    // That left a Fork-C (P4) vision-only trigger entering deliberation with
    // nothing retrievable (ungrounded Type-2 load). Split the two cases the old
    // gate conflated, keyed on whether text was PRESENT, not whether it matched.
    const textPresent = 'text' in modalityEmbeddings;
    const textMatched = matches.some(m => m.modality === 'text');

    // (1) Text was offered but didn't match → still a stale replay; discard.
    //     This preserves the original guard BYTE-FOR-BYTE for text-bearing frames.
    if (textPresent && !textMatched) {
      this.logger.debug(
        'searchMultiModal: text present but unmatched — discarding stale matches.',
      );
      return null;
    }

    // (2) Text ABSENT (a vision-only perception) → permit a hit ONLY if it is
    //     anchored by a visual_embedding match. searchByModality already gated
    //     that match on the conservative 0.80 cosine + min-population + runner-up
    //     + zero-vector guards, so an UNSEEN scene returns null here (no
    //     confabulation). Audio/drive-only self-ticks (no visual anchor) still
    //     discard, preserving the stale-replay guard.
    if (!textPresent) {
      const visualAnchored = matches.some(
        m => m.modality === 'visual_embedding',
      );
      if (!visualAnchored) {
        this.logger.debug(
          'searchMultiModal: no text and no visual_embedding anchor — discarding.',
        );
        return null;
      }
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

    // STANDARD 3: write-time confidence ceiling. A new pattern has useCount 0
    // (proposed, never proven), so its confidence is hard-capped at 0.60 here —
    // unconditionally, with NO guardian/provenance bypass. Confidence may only
    // exceed the ceiling later via the legitimate reinforced path (useCount > 0).
    const clampedConfidence = Math.min(WRITE_TIME_CONFIDENCE_CEILING, pattern.confidence);

    this.hotLayer.push({
      id,
      modality: pattern.modality,
      embedding: pattern.stimulusEmbedding,
      responseText: pattern.responseText,
      procedureId: pattern.procedureId ?? null,
      confidence: clampedConfidence,
      useCount: 0,
      entityIds: [...pattern.entityIds],
      knowledgeGrounding: pattern.knowledgeGrounding ?? null,
      groundingPersonId: pattern.groundingPersonId ?? null,
    });

    vlog('latent write', {
      modality: pattern.modality,
      patternId: id.substring(0, 8),
      confidence: +clampedConfidence.toFixed(2),
      entityCount: pattern.entityIds.length,
      hotLayerSize: this.hotLayer.length,
      responsePreview: pattern.responseText.substring(0, 60),
    });

    this.logger.debug(
      `Latent space write [${pattern.modality}]: pattern ${id.substring(0, 8)} ` +
        `(confidence: ${clampedConfidence.toFixed(2)}, entities: ${pattern.entityIds.length}). ` +
        `Hot layer: ${this.hotLayer.length} patterns.`,
    );

    if (this.timescale && this.schemaReady) {
      const embeddingLiteral = `[${pattern.stimulusEmbedding.join(',')}]`;
      const writePromise = this.timescale.query(
        `INSERT INTO learned_patterns
           (id, modality, stimulus_embedding, response_text, procedure_id, confidence,
            use_count, recent_mae, deliberation_summary, entity_ids,
            created_at, last_used_at, session_id, knowledge_grounding,
            grounding_person_id)
         VALUES ($1, $2, $3::vector, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          id,
          pattern.modality,
          embeddingLiteral,
          pattern.responseText,
          pattern.procedureId ?? null,
          clampedConfidence,
          0,
          0,
          pattern.deliberationSummary ?? null,
          pattern.entityIds,
          now,
          null,
          pattern.sessionId ?? null,
          pattern.knowledgeGrounding ?? null,
          pattern.groundingPersonId ?? null,
        ],
      ).then(() => {
        // Remove from pending list on success
        this.pendingWrites = this.pendingWrites.filter(p => p !== writePromise);
      }).catch((err) => {
        this.pendingWrites = this.pendingWrites.filter(p => p !== writePromise);
        this.logger.warn(`Warm layer write failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      this.pendingWrites.push(writePromise);
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
      // Wave 3 / C6 — drive/face modalities are intentionally NOT written to the
      // shared conversational index (a separate person-scoped index is deferred
      // to a later wave). Audit the drop instead of swallowing it silently
      // (Std-1): count it and emit a one-time warn per modality so callers can
      // see that supplied drive/face embeddings are being dropped, not stored.
      if (modality === 'drives' || modality === 'faces') {
        const prior = this.droppedModalityWrites.get(modality) ?? 0;
        this.droppedModalityWrites.set(modality, prior + 1);
        if (prior === 0) {
          this.logger.warn(
            `writeMultiModal: dropping '${modality}' modality writes — not yet ` +
              `indexed (separate person-scoped index deferred; Wave 3 C6). ` +
              `Supplied ${modality} embeddings are NOT persisted.`,
          );
        }
        continue;
      }

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

  /**
   * Wave 3 / C6 — observability for intentionally-dropped modality writes
   * (drives/faces). Returns a snapshot of how many writes were dropped per
   * modality this process lifetime, so the drop is auditable rather than silent.
   */
  getDroppedModalityWriteCounts(): Record<string, number> {
    return Object.fromEntries(this.droppedModalityWrites);
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

  /**
   * Update the confidence of a pattern (after outcome evaluation).
   *
   * STANDARD 3: this is the SECOND write path to confidence and is gated by the
   * same write-time ceiling as write(). At useCount 0 the pattern is still
   * unproven, so confidence is hard-capped at 0.60 here too — a caller cannot set
   * 0.95 on a never-used pattern. Only once useCount > 0 (the pattern has been
   * retrieved and used) may the legitimate reinforced path raise it past the
   * ceiling. Lowering confidence (e.g. on a counter-indicated outcome) is always
   * allowed — a reduction never breaches a ceiling.
   *
   * The DB write applies the same gate atomically against the *persisted*
   * use_count via CASE, so an in-memory/DB useCount skew cannot open a hole.
   */
  updateConfidence(patternId: string, newConfidence: number): void {
    const entry = this.hotLayer.find((e) => e.id === patternId);
    if (entry) {
      // Hot-layer gate: cap at the ceiling while the pattern is unproven (useCount 0).
      entry.confidence =
        entry.useCount > 0
          ? newConfidence
          : Math.min(WRITE_TIME_CONFIDENCE_CEILING, newConfidence);
    }

    if (this.timescale && this.schemaReady) {
      // DB gate: enforce the ceiling against the persisted use_count. When
      // use_count = 0 the stored value is LEAST(newConfidence, 0.60); once
      // use_count > 0 the reinforced value is written verbatim.
      this.timescale.query(
        `UPDATE learned_patterns
         SET confidence = CASE
           WHEN use_count > 0 THEN $1
           ELSE LEAST($1, $3)
         END
         WHERE id = $2`,
        [newConfidence, patternId, WRITE_TIME_CONFIDENCE_CEILING],
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

  /**
   * Clear ONLY the in-memory hot layer, leaving the persistent warm layer
   * (learned_patterns) untouched. Non-destructive: the hot layer re-hydrates
   * from the warm layer on the next boot, so no accumulated data is lost.
   *
   * Used to give the Provability Gate a COLD latent index for a single run —
   * latent search then reflects only patterns written during that run — without
   * discarding the persisted patterns. (A durable hermetic gate would instead
   * truncate the warm layer via clear(); that is a deliberate, separately
   * authorized action because it is irreversible.)
   */
  clearHotLayer(): number {
    const count = this.hotLayer.length;
    this.hotLayer = [];
    this.logger.warn(
      `Latent hot layer cleared (non-destructive): ${count} patterns removed; warm layer (learned_patterns) preserved.`,
    );
    return count;
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  /** Number of patterns in the hot layer. */
  get hotLayerSize(): number {
    return this.hotLayer.length;
  }

  /** Count of hot-layer patterns for a given modality (gate/diagnostic use). */
  hotLayerSizeForModality(modality: string): number {
    return this.hotLayer.reduce((n, e) => (e.modality === modality ? n + 1 : n), 0);
  }

  // ---------------------------------------------------------------------------
  // Gate seam — seed a single over-general pattern (WS1 follow-up #3)
  // ---------------------------------------------------------------------------

  /**
   * GATE/TEST SEAM — clear the hot layer and seed EXACTLY ONE text pattern with
   * useCount 0, leaving the modality population at 1.
   *
   * This reproduces, in-memory and non-destructively, the precise production
   * hazard the min-population trust gate defends against: a fresh boot (or a
   * re-accumulated warm layer) holding a single over-general pattern that would
   * otherwise fire a confident GROUNDED Type 1 reflex on any grazing input. The
   * provability gate's H1 probe seeds the document-embedding of a NONSENSE input
   * here (worst case: near-1.0 cosine), then feeds that nonsense and asserts the
   * response is NOT a confident GROUNDED reflex — the real proof that the gate
   * exists, distinct from H0 (clearHotLayer) which would stay green either way.
   *
   * Hot-layer only: the persistent warm layer (learned_patterns) is untouched, so
   * this is non-destructive and re-hydrates normally on the next boot.
   *
   * @returns The seeded pattern's id, and the resulting hot-layer size (always 1).
   */
  seedSingleOverGeneralPattern(
    embedding: number[],
    responseText = 'over-general seeded reflex',
  ): { id: string; hotLayerSize: number } {
    this.hotLayer = [];
    const id = randomUUID();
    this.hotLayer.push({
      id,
      modality: 'text',
      embedding,
      responseText,
      procedureId: null,
      confidence: 0.9,
      useCount: 0, // fresh / unproven — must NOT clear the trust floor
      entityIds: [],
      knowledgeGrounding: 'GROUNDED', // worst case: pattern claims GROUNDED
      groundingPersonId: null,
    });
    this.logger.warn(
      `Seeded a SINGLE over-general hot-layer pattern ${id.substring(0, 8)} (useCount 0) ` +
        `for the no-clear gate probe (H1). Warm layer untouched.`,
    );
    return { id, hotLayerSize: this.hotLayer.length };
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

      // Add knowledge_grounding column if upgrading from older schema
      await this.timescale.query(`
        ALTER TABLE learned_patterns
        ADD COLUMN IF NOT EXISTS knowledge_grounding TEXT
      `);

      // WS4 Ticket 5 (§3.1/§3.4) — person scope for GROUNDED replay isolation.
      // Additive, nullable, no default. NULL = world-scoped; non-null = OKG-scoped
      // to that personId.
      //
      // Existing rows are NULL = world-scoped, and this is DELIBERATE, not an
      // oversight: legacy rows predate multi-person operation (guardian-only
      // sessions), so treating them as person-scoped would lobotomize the entire
      // warm layer the instant a second person connects — for zero privacy
      // benefit, since those patterns were never grounded off a non-guardian's
      // private OKG. The conservative-when-ambiguous rule applies only to NEW
      // writes (decision-making.service.ts write-time scoping); for the historical
      // corpus, world-scoped is both safe and correct.
      await this.timescale.query(`
        ALTER TABLE learned_patterns
        ADD COLUMN IF NOT EXISTS grounding_person_id TEXT
      `);

      // STANDARD 3 BACKSTOP — confidence ceiling enforced at the schema level.
      // No row may exceed 0.60 confidence while use_count = 0 (proposed-but-never-
      // used). This is the durable last line of defence behind the write() and
      // updateConfidence() application-layer clamps: even a future code path that
      // forgot to clamp cannot persist a Std-3 breach.
      //
      // Order matters: a populated table may already hold violating rows (written
      // before this fix), so we CLAMP them first, THEN add the CHECK — otherwise
      // the ALTER ... ADD CONSTRAINT fails validation on the existing data.
      await this.timescale.query(`
        UPDATE learned_patterns
        SET confidence = 0.60
        WHERE use_count = 0 AND confidence > 0.60
      `);

      // Constraint-add is guarded (idempotent): ADD CONSTRAINT is not IF-NOT-EXISTS
      // in all PG versions, so we catch the duplicate_object error (42710) on a
      // re-run rather than letting it abort schema setup.
      try {
        await this.timescale.query(`
          ALTER TABLE learned_patterns
          ADD CONSTRAINT learned_patterns_std3_confidence_ceiling
          CHECK (use_count > 0 OR confidence <= 0.60)
        `);
      } catch (constraintErr: unknown) {
        const code = (constraintErr as { code?: string })?.code;
        const message =
          constraintErr instanceof Error ? constraintErr.message : String(constraintErr);
        // 42710 = duplicate_object (constraint already exists). Any other code is a
        // real failure worth surfacing.
        if (code === '42710' || /already exists/i.test(message)) {
          this.logger.debug(
            'Std-3 confidence-ceiling CHECK constraint already present — skipping.',
          );
        } else {
          throw constraintErr;
        }
      }

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
        knowledge_grounding: string | null;
        grounding_person_id: string | null;
      }>(
        `SELECT id, COALESCE(modality, 'fused') AS modality,
                stimulus_embedding::text, response_text, procedure_id,
                confidence, use_count, entity_ids, knowledge_grounding,
                grounding_person_id
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
            knowledgeGrounding: isValidGrounding(row.knowledge_grounding)
              ? row.knowledge_grounding
              : null,
            groundingPersonId: row.grounding_person_id ?? null,
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
      knowledgeGrounding: entry.knowledgeGrounding,
      groundingPersonId: entry.groundingPersonId,
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Type guard for knowledge grounding values stored in the DB.
 * Rejects null / stale / unknown strings from pre-field-addition rows.
 */
function isValidGrounding(v: string | null): v is KnowledgeGrounding {
  return v === 'GROUNDED' || v === 'LLM_ASSISTED' || v === 'UNKNOWN';
}

/**
 * WS4 Ticket 5 (§3.2) — replay-time person-scope demotion (PURE).
 *
 * Single source of truth for the privacy invariant: a pattern whose GROUNDED
 * claim is backed by person A's private OKG must not replay GROUNDED to person B.
 * The decision-making latent-replay path calls this BEFORE applyOkgRecallGrounding,
 * so an honest re-ground off the CURRENT speaker's own facts can still happen.
 *
 * Demotes (GROUNDED → UNKNOWN), never suppresses — the cached reflex still fires;
 * only the borrowed grounding is stripped (theater prohibition / no behavior cliff).
 *
 * @param grounding        The base grounding from groundingForCachedPattern().
 * @param groundingPersonId The pattern's person scope (null = world-scoped).
 * @param currentPersonId  The current speaker's personId (null = unknown speaker).
 * @returns { grounding, demoted } — demoted=true iff a GROUNDED was stripped.
 */
export function applyPersonScopeDemotion(
  grounding: KnowledgeGrounding,
  groundingPersonId: string | null,
  currentPersonId: string | null,
): { grounding: KnowledgeGrounding; demoted: boolean } {
  // World-scoped (null) replays to anyone; a matching personId replays to its owner.
  const personScopeOk = groundingPersonId === null || groundingPersonId === currentPersonId;
  if (grounding === 'GROUNDED' && !personScopeOk) {
    return { grounding: 'UNKNOWN', demoted: true };
  }
  return { grounding, demoted: false };
}
