/**
 * EpisodicMemoryService — Ring buffer episodic memory store.
 *
 * CANON §Subsystem 1 (Decision Making): Episodic memory is the in-process,
 * in-memory record of recent experiences. It is NOT the WKG. The Learning
 * subsystem may promote episode content into WKG nodes via consolidation,
 * but the episodic store itself is local to DecisionMakingModule.
 *
 * Ring buffer capacity: 50 episodes (CANON §Episodic Memory). When the
 * buffer is full the oldest episode (head pointer) is overwritten.
 *
 * Encoding gate: an episode is only stored if attention OR arousal > 0.60.
 * If neither condition holds, encode() returns null (SKIP path).
 *
 * ageWeight formula: attention * exp(-0.1 * hoursSinceEncoding). At encoding
 * time (t=0) the exponent is 0, so ageWeight = attention.
 *
 * Context similarity matching uses Jaccard similarity on whitespace-tokenised
 * fingerprint tokens. Episodes are returned when similarity > 0.70.
 *
 * Adapted from sylphie-old:
 * - Episode type imported from @sylphie/shared (not locally defined).
 * - Event logging via DECISION_EVENT_LOGGER instead of createDecisionMakingEvent.
 */

import { Injectable, Inject, Logger, Optional, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  type Episode,
  type EpisodeInput,
  type EncodingDepth,
  type DriveSnapshot,
  DriveName,
  DRIVE_INDEX_ORDER,
  EMBEDDING_VERSION,
  TimescaleService,
  verboseFor,
} from '@sylphie/shared';

const vlog = verboseFor('Memory');
import type {
  IEpisodicMemoryService,
  IDecisionEventLogger,
} from '../interfaces/decision-making.interfaces';
import { DECISION_EVENT_LOGGER } from '../decision-making.tokens';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of episodes in the ring buffer (CANON §Episodic Memory). */
const RING_BUFFER_CAPACITY = 50;

/**
 * Encoding gate threshold. Either attention or arousal must exceed this.
 *
 * Set to 0.15 (not 0.60) because attention and arousal are computed from
 * drive averages that start near zero and accumulate slowly. At 0.60 the
 * gate rejected ALL normal conversation — drives rarely reach that level
 * within the first 30 minutes of a session. At 0.15, episodes begin
 * encoding after 2-3 minutes of active conversation, which is when the
 * curiosity + anxiety average crosses this threshold.
 */
export const ENCODING_GATE_THRESHOLD = 0.15;

/**
 * Jaccard threshold for the SHA-fingerprint path (queryByFingerprint).
 *
 * Calibrated for the near-binary SHA-token Jaccard: two frames that quantize to
 * the same fingerprint slice share almost all tokens, an unrelated frame shares
 * almost none. LEFT INTACT by WS5 T2 — only queryByFingerprint uses it.
 */
const CONTEXT_SIMILARITY_THRESHOLD = 0.70;

// ---------------------------------------------------------------------------
// WS5 T2.2 — content-recall threshold (ADDITIVE; SHA threshold left untouched)
// ---------------------------------------------------------------------------

/**
 * Content-overlap threshold for the free-text CONTENT path (queryByContent).
 *
 * 0.70 (the SHA threshold) is wrong-by-construction for NL-vs-caption recall, and
 * SYMMETRIC Jaccard is too — the LIVE gateway composes a VERBOSE multi-line scene
 * description (e.g. "Scene: a red mug on the windowsill\n- bottle (unrecognized),
 * present <1s" + a "Tracked entities:" inputSummary block), so a 1-token query
 * ("mug") Jaccards at ~0.09 against an ~11-token content blob purely from union
 * inflation, NOT from a missing content match. Lowering a Jaccard threshold to
 * chase that is fragile: a longer caption pushes it lower still.
 *
 * Instead, content recall uses the OVERLAP COEFFICIENT (containment):
 *   overlap(query, content) = |query ∩ content| / min(|query|, |content|)
 * i.e. "how much of the SHORTER token set is contained in the longer one." A
 * short NL query whose content noun appears anywhere in a long caption scores
 * high regardless of caption verbosity; a wrong-noun query scores 0. This is the
 * correct metric for short-query-vs-verbose-content recall and is robust to the
 * gateway's caption length.
 *
 * Measured overlap with the SHIPPED tokeniseContent + CONTENT_STOPWORDS, against
 * the LIVE-COMPOSED content blob (caption + sceneLabels + inputSummary, recorded
 * from the T2 smoke), for the ticket:
 *   POSITIVES (must clear the gate):
 *     "did you see a mug earlier?"  VS  live blob {scene,red,mug,windowsill,
 *        bottle,unrecognized,present,1s,multimodal,tracked,cup}            → 1.00
 *     "did you see a cat earlier?"  VS  "a cat on the windowsill"          → 1.00
 *     "what do you see?" (→ ∅ after stopwords)                            → 0.00 (no content noun → no match, correct)
 *   NEGATIVES (must NOT clear the gate):
 *     "did you see a dog earlier?"  VS  live mug blob                      → 0.00
 *     "did you see a bird earlier?" VS  live mug blob                      → 0.00
 *
 * With overlap, a positive content-noun match is 1.00 and every wrong-noun
 * negative is 0.00 — a maximally clean separation. The threshold 0.50 sits
 * squarely between (and demands a real content-token hit, not an incidental
 * stopword): a single matched content noun in a 1-token query clears it; zero
 * matched content tokens cannot. (Strict `>` in queryByContent.)
 */
const CONTENT_SIMILARITY_THRESHOLD = 0.50;

/**
 * WS5 T2.5 — mood-congruent retrieval blend weight (alpha).
 *
 * compositeScore = (1 - alpha) * contentJaccard + alpha * driveCosine. A
 * loop-gain parameter (ashby), NOT a free tuning call: ship 0.20 (ceiling 0.25).
 * Valid ONLY as the triple {sceneSurprise→attention-only (T1.0), bounded alpha,
 * rumination breaker present}. The breaker (below) forces alpha→0 on a trip.
 */
const MOOD_CONGRUENT_ALPHA = 0.20;

/**
 * WS5 T2.4 — recall-local recency-decay half-life (hours).
 *
 * effectiveWeight = ageWeight * 2^(-ageHours / RECALL_RECENCY_HALFLIFE_HOURS),
 * applied ONLY inside queryByContent's sort comparator. A fresh moderate visual
 * episode thus outranks a stale high-attention one (P4's "earlier" needs recency
 * to win). 6h half-life: a same-session "earlier" episode keeps ~full weight; a
 * day-old one is heavily attenuated.
 */
const RECALL_RECENCY_HALFLIFE_HOURS = 6;

// ---------------------------------------------------------------------------
// WS5 T2.5 — rumination circuit-breaker (ashby spec)
// ---------------------------------------------------------------------------

/** Sliding window of the last N queryByContent retrievals the breaker inspects. */
const RUMINATION_WINDOW = 10;
/** ≥ this many mood-congruent retrievals in the window is a trip pre-condition. */
const RUMINATION_MIN_CONGRUENT = 8;
/** ≤ this many DISTINCT episode ids in the window is the other trip pre-condition. */
const RUMINATION_MAX_DISTINCT = 3;
/** On trip, force alpha→0 for this many subsequent retrievals. */
const RUMINATION_SUPPRESS_K = 3;
/**
 * A retrieval counts as "mood-congruent" for the breaker window iff its top
 * result's drive-cosine to the query mood exceeds this. The breaker measures
 * the affect channel's grip on retrieval, independent of the content match.
 */
const RUMINATION_CONGRUENT_COSINE = 0.90;

// ---------------------------------------------------------------------------
// EpisodicMemoryService
// ---------------------------------------------------------------------------

@Injectable()
export class EpisodicMemoryService implements IEpisodicMemoryService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EpisodicMemoryService.name);
  private schemaReady = false;

  /**
   * Ring buffer storage. Entries may be undefined when the buffer is not yet
   * full. TypeScript initialises Array slots to undefined by default.
   */
  private readonly buffer: Array<Episode | undefined> = new Array<Episode | undefined>(
    RING_BUFFER_CAPACITY,
  ).fill(undefined);

  /**
   * Index of the oldest episode slot in the ring buffer (the next write
   * position). Incremented (mod capacity) on every successful encode.
   */
  private head = 0;

  /** Total number of episodes successfully encoded, capped at capacity for count reporting. */
  private count = 0;

  // -------------------------------------------------------------------------
  // WS5 T2.5 — rumination circuit-breaker state (inspectable for a gate row)
  //
  // The breaker bounds the retrieval-side edge of the perception→drive→perception
  // loop. It WRITES NOTHING TO DRIVES (Std 6 — no self-modification of
  // evaluation); it only suppresses its own alpha and emits an audit event. All
  // state is in-process and inspectable via getRuminationState() so a future gate
  // row can assert the trip directly.
  // -------------------------------------------------------------------------

  /** Sliding window of the last RUMINATION_WINDOW queryByContent retrievals. */
  private readonly ruminationWindow: Array<{ topEpisodeId: string | null; moodCongruent: boolean }> = [];

  /** Remaining retrievals for which alpha is forced to 0 after a trip. */
  private ruminationSuppressRemaining = 0;

  /** Total number of times the breaker has tripped this process (audit/gate). */
  private ruminationTripCount = 0;

  /** Wall-clock of the most recent trip, or null if never tripped. */
  private lastRuminationTripAt: Date | null = null;

  constructor(
    @Optional()
    @Inject(DECISION_EVENT_LOGGER)
    private readonly eventLogger: IDecisionEventLogger | null,

    @Optional()
    @Inject(TimescaleService)
    private readonly timescale: TimescaleService | null,
  ) {}

  // ---------------------------------------------------------------------------
  // Persistence — save/restore ring buffer across restarts
  // ---------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    if (!this.timescale) return;
    try {
      await this.timescale.query(`
        CREATE TABLE IF NOT EXISTS episodic_memory_checkpoint (
          slot INTEGER PRIMARY KEY,
          episode JSONB NOT NULL
        )
      `);
      this.schemaReady = true;

      // Restore episodes from checkpoint
      const result = await this.timescale.query<{ slot: number; episode: string }>(
        `SELECT slot, episode FROM episodic_memory_checkpoint ORDER BY slot`,
      );

      if (result.rows.length > 0) {
        let maxSlot = -1;
        for (const row of result.rows) {
          const ep = typeof row.episode === 'string' ? JSON.parse(row.episode) : row.episode;
          // Restore Date objects from ISO strings
          ep.timestamp = new Date(ep.timestamp);
          ep.driveSnapshot.timestamp = new Date(ep.driveSnapshot.timestamp);
          // WS5 T1.1 — deserialization shim. Pre-T1 checkpoint rows have no
          // `source` field. Back-fill the 'legacy' SENTINEL (NOT 'conversation')
          // BEFORE the `as Episode` cast, so the required discriminant is always
          // present. 'legacy' is deliberate: P4 asserts `source === 'perception'`
          // positively and `source !== 'conversation'` — a 'conversation'
          // back-fill would satisfy neither honestly and could mask a real
          // perception episode that failed to persist its source. 'legacy' rows
          // are neither, so they never vacuously pass a perception assertion.
          ep.source ??= 'legacy';
          // P1 #0+#3 — deserialization shim. Pre-P1 checkpoint rows have no
          // `embeddingVersion`. Back-fill `1` (the original 6-modality + first-64
          // fingerprint scheme) BEFORE the cast, so the field is always present.
          // A legacy v1 fingerprint stays a clean versioned MISS against the
          // current EMBEDDING_VERSION query path — never a corrupted cross-version
          // hit (the version is also baked into the fingerprint hash preimage).
          ep.embeddingVersion ??= 1;
          this.buffer[row.slot] = ep as Episode;
          if (row.slot > maxSlot) maxSlot = row.slot;
        }
        this.count = result.rows.length;
        this.head = (maxSlot + 1) % RING_BUFFER_CAPACITY;
        this.logger.log(`Restored ${this.count} episodes from checkpoint`);
      }
    } catch (err) {
      this.logger.warn(`Episodic memory persistence init failed: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.timescale || !this.schemaReady || this.count === 0) return;
    try {
      await this.timescale.query('TRUNCATE episodic_memory_checkpoint');
      for (let i = 0; i < RING_BUFFER_CAPACITY; i++) {
        const ep = this.buffer[i];
        if (ep) {
          await this.timescale.query(
            `INSERT INTO episodic_memory_checkpoint (slot, episode) VALUES ($1, $2)`,
            [i, JSON.stringify(ep)],
          );
        }
      }
      this.logger.log(`Saved ${this.count} episodes to checkpoint`);
    } catch (err) {
      this.logger.error(`Failed to save episodic memory: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // IEpisodicMemoryService — encode
  // ---------------------------------------------------------------------------

  /**
   * Encode a new experience into episodic memory.
   *
   * Encoding gate: if neither attention nor arousal exceeds 0.60, the episode
   * is discarded and null is returned (EncodingDepth.SKIP path, regardless of
   * the caller-supplied encodingDepth argument).
   *
   * If the gate passes, the episode is written to the ring buffer at the
   * current head position and head is advanced. ageWeight is set to
   * input.attention * exp(-0.1 * 0) = input.attention at encode time (t=0).
   *
   * A EPISODE_ENCODED event is emitted via the event logger for every stored
   * episode (all depths except effective SKIP).
   *
   * @param input         - Raw experience data.
   * @param encodingDepth - Requested encoding depth. Overridden to SKIP if
   *                        the encoding gate rejects the input.
   * @returns The encoded Episode, or null if the gate rejected the input.
   */
  async encode(input: EpisodeInput, encodingDepth: EncodingDepth): Promise<Episode | null> {
    // Encoding gate: SKIP if both attention and arousal are below threshold.
    if (
      input.attention <= ENCODING_GATE_THRESHOLD &&
      input.arousal <= ENCODING_GATE_THRESHOLD
    ) {
      vlog('episode encoding REJECTED', { attention: +input.attention.toFixed(3), arousal: +input.arousal.toFixed(3), threshold: ENCODING_GATE_THRESHOLD });
      this.logger.debug(
        `Encoding gate rejected episode: attention=${input.attention}, arousal=${input.arousal}`,
      );
      return null;
    }

    const effectiveDepth: EncodingDepth =
      encodingDepth === 'SKIP' ? 'SHALLOW' : encodingDepth;

    // ageWeight = attention at encode time (t=0, exponent evaluates to 1).
    const ageWeight = input.attention;

    const episode: Episode = {
      id: randomUUID(),
      // WS5 T1.1/T1.2 — persist the required modality discriminant and the
      // per-sub-field-provenance visual content (the latter only when present,
      // i.e. vision-dominant episodes). The recall surface (T2) reads `source`
      // to derive per-episode provenance.
      source: input.source,
      ...(input.visualContext !== undefined ? { visualContext: input.visualContext } : {}),
      timestamp: new Date(),
      driveSnapshot: input.driveSnapshot,
      inputSummary: input.inputSummary,
      actionTaken: input.actionTaken,
      predictionIds: [],
      ageWeight,
      encodingDepth: effectiveDepth,
      contextFingerprint: input.contextFingerprint,
      // P1 #0+#3: persist the embedding/fingerprint scheme version as first-class
      // provenance. Defaults to the current EMBEDDING_VERSION when the caller does
      // not supply one. Rides free in the checkpoint JSONB (no DB migration).
      embeddingVersion: input.embeddingVersion ?? EMBEDDING_VERSION,
      // WS4 T3: persist speaker attribution (absent for self-initiated cycles).
      ...(input.speakerId !== undefined
        ? { speakerId: input.speakerId, speakerIsGuardian: input.speakerIsGuardian ?? false }
        : {}),
      // EP14.5a (TK-89): additive spread — only present when deliberation threw.
      // Absent on all normal (non-error) episodes so consumers that do not
      // inspect this field are entirely unaffected.
      ...(input.cycleErrorContext !== undefined
        ? { cycleErrorContext: input.cycleErrorContext }
        : {}),
    };

    // Write to the ring buffer at head, then advance.
    this.buffer[this.head] = episode;
    this.head = (this.head + 1) % RING_BUFFER_CAPACITY;
    this.count = Math.min(this.count + 1, RING_BUFFER_CAPACITY);

    vlog('episode encoded', {
      id: episode.id.substring(0, 8),
      depth: effectiveDepth,
      ageWeight: +ageWeight.toFixed(3),
      bufferCount: this.count,
      action: input.actionTaken,
      summary: input.inputSummary.substring(0, 80),
    });

    this.logger.debug(
      `Episode encoded (depth=${effectiveDepth}, id=${episode.id}, ageWeight=${ageWeight.toFixed(3)})`,
    );

    this.emitEpisodeEncoded(episode, input.driveSnapshot);

    return episode;
  }

  // ---------------------------------------------------------------------------
  // IEpisodicMemoryService — getRecentEpisodes
  // ---------------------------------------------------------------------------

  /**
   * Return the most recent episodes in reverse-chronological order.
   *
   * Iterates the ring buffer from the most recently written slot backwards,
   * collecting up to `count` non-undefined entries. The returned array is a
   * snapshot — mutations do not affect the buffer.
   *
   * @param count - Maximum number of episodes to return. Defaults to 10.
   * @returns Read-only array of episodes, newest first. Empty if no episodes.
   */
  getRecentEpisodes(count = 10): readonly Episode[] {
    const results: Episode[] = [];
    const capacity = RING_BUFFER_CAPACITY;

    // The most recently written slot is at (head - 1 + capacity) % capacity.
    let readIdx = (this.head - 1 + capacity) % capacity;
    let examined = 0;

    while (examined < this.count && results.length < count) {
      const episode = this.buffer[readIdx];
      if (episode !== undefined) {
        results.push(episode);
      }
      readIdx = (readIdx - 1 + capacity) % capacity;
      examined++;
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // IEpisodicMemoryService — queryByContext
  // ---------------------------------------------------------------------------

  /**
   * WS5 T2.1 — back-compat alias. The IEpisodicMemoryService contract still
   * exposes queryByContext; it now delegates to the SHA-fingerprint path so any
   * legacy caller keeps the exact prior semantics. New code should call
   * queryByFingerprint (SHA) or queryByContent (free-text recall) directly.
   */
  queryByContext(contextFingerprint: string, limit = 5): readonly Episode[] {
    return this.queryByFingerprint(contextFingerprint, limit);
  }

  /**
   * WS5 T2.1 — SHA context-fingerprint match (split out VERBATIM from the old
   * queryByContext; behavior unchanged).
   *
   * Tokenises both the query fingerprint and each stored episode's fingerprint
   * by splitting on whitespace, then computes the Jaccard coefficient
   * (|intersection| / |union|). Episodes with Jaccard > CONTEXT_SIMILARITY_THRESHOLD
   * (0.70) are included.
   *
   * Results are sorted by STORED ageWeight descending — FROZEN by T2.4: this sort
   * is unchanged and applies no recall-local recency transform (that lives only in
   * queryByContent). Used by the per-cycle context lookup (process-input.service).
   *
   * @param contextFingerprint - The fingerprint to query against.
   * @param limit              - Maximum results to return. Defaults to 5.
   * @returns Read-only array of matching episodes, sorted by ageWeight desc.
   */
  queryByFingerprint(contextFingerprint: string, limit = 5): readonly Episode[] {
    const queryTokens = tokenise(contextFingerprint);
    const matches: Array<{ episode: Episode; similarity: number }> = [];

    for (const episode of this.buffer) {
      if (episode === undefined) continue;

      const episodeTokens = tokenise(episode.contextFingerprint);
      const similarity = jaccardSimilarity(queryTokens, episodeTokens);

      if (similarity > CONTEXT_SIMILARITY_THRESHOLD) {
        matches.push({ episode, similarity });
      }
    }

    // Sort by ageWeight descending; use similarity as a tiebreaker.
    // FROZEN (T2.4): stored ageWeight, no recall-local recency transform here.
    matches.sort((a, b) => {
      const weightDiff = b.episode.ageWeight - a.episode.ageWeight;
      return weightDiff !== 0 ? weightDiff : b.similarity - a.similarity;
    });

    const results = matches.slice(0, limit).map((m) => m.episode);

    vlog('episodic memory queryByFingerprint', {
      queriedFingerprint: contextFingerprint.substring(0, 16),
      matches: results.length,
      topSimilarity: matches.length > 0 ? +matches[0].similarity.toFixed(3) : null,
      bufferCount: this.count,
    });

    return results;
  }

  /**
   * WS5 T2.1 — free-text CONTENT recall (the "what did you see?" path).
   *
   * Matches a natural-language query against each episode's CONTENT tokens
   * (visualContext caption + sceneLabels + inputSummary), stopword-filtered, with:
   *   - T2.2: a SEPARATE additive threshold CONTENT_SIMILARITY_THRESHOLD (0.50),
   *           scored by the OVERLAP COEFFICIENT (containment) — robust to the
   *           gateway's verbose caption (the SHA-Jaccard 0.70 path is untouched).
   *   - T2.5: a bounded mood-congruent blend
   *           compositeScore = (1-α)·contentOverlap + α·driveCosine, α=0.20.
   *   - T2.4: a RECALL-LOCAL recency decay applied only at the sort comparator
   *           (stored ageWeight is NOT mutated; consolidation reads are untouched).
   *   - T2.5: a rumination circuit-breaker that, on trip, forces α→0 for K=3
   *           retrievals, writes NOTHING to drives, and emits a gate-assertable
   *           RUMINATION_BREAKER_TRIPPED event.
   *
   * @param queryText - Free-text query (e.g. "did you see a cat earlier?").
   * @param limit     - Maximum results to return. Defaults to 5.
   * @param queryMood - Optional current drive snapshot supplied by the caller
   *                    (the episodic service never reads the Drive Engine itself,
   *                    keeping drive-isolation clean). Absent → α treated as 0.
   * @returns Read-only array of matching episodes, ranked by blended recall score.
   */
  queryByContent(
    queryText: string,
    limit = 5,
    queryMood?: DriveSnapshot,
  ): readonly Episode[] {
    const queryTokens = tokeniseContent(queryText);
    const now = Date.now();

    // T2.5 — alpha is suppressed to 0 while the breaker is in its K-retrieval
    // cooldown. Decrement happens at the END of this call (one retrieval = one
    // step). A missing query mood also collapses alpha to 0 (content-only).
    const alphaActive = this.ruminationSuppressRemaining === 0 && queryMood !== undefined;
    const alpha = alphaActive ? MOOD_CONGRUENT_ALPHA : 0;

    const matches: Array<{
      episode: Episode;
      contentOverlap: number;
      driveCosine: number;
      composite: number;
      effectiveWeight: number;
    }> = [];

    for (const episode of this.buffer) {
      if (episode === undefined) continue;

      // T2.2 — OVERLAP COEFFICIENT (containment), not symmetric Jaccard: robust
      // to the gateway's verbose multi-line caption (see CONTENT_SIMILARITY_THRESHOLD).
      const episodeTokens = tokeniseContent(contentBlob(episode));
      const contentOverlap = overlapCoefficient(queryTokens, episodeTokens);
      if (contentOverlap <= CONTENT_SIMILARITY_THRESHOLD) continue;

      // Mood cosine is always COMPUTED (the breaker needs it even when α=0), but
      // only BLENDED into the score when alpha > 0.
      const driveCosine =
        queryMood !== undefined
          ? driveCosineSimilarity(queryMood, episode.driveSnapshot)
          : 0;

      const composite = (1 - alpha) * contentOverlap + alpha * driveCosine;

      // T2.4 — recall-local recency decay (NOT mutating episode.ageWeight; NOT
      // touching consolidation reads). A fresh moderate episode can outrank a
      // stale high-attention one — required for P4's "earlier" to win.
      const ageHours = Math.max(0, (now - episode.timestamp.getTime()) / 3_600_000);
      const effectiveWeight = episode.ageWeight * recencyDecay(ageHours);

      matches.push({ episode, contentOverlap, driveCosine, composite, effectiveWeight });
    }

    // Rank by composite score, then by recall-local effectiveWeight (recency-
    // decayed ageWeight) as the tiebreaker. THIS is the only sort site that
    // applies the recency transform — queryByFingerprint stays frozen.
    matches.sort((a, b) => {
      const compDiff = b.composite - a.composite;
      if (Math.abs(compDiff) > 1e-9) return compDiff;
      return b.effectiveWeight - a.effectiveWeight;
    });

    const results = matches.slice(0, limit).map((m) => m.episode);

    // T2.5 — feed the breaker AFTER ranking: record this retrieval's top result
    // and whether it was mood-congruent, then evaluate the sliding window.
    const top = matches[0];
    this.recordRetrievalForBreaker(
      top ? top.episode.id : null,
      top ? top.driveCosine : 0,
      queryMood,
    );

    vlog('episodic memory queryByContent', {
      query: queryText.substring(0, 40),
      matches: results.length,
      topContentOverlap: top ? +top.contentOverlap.toFixed(3) : null,
      topDriveCosine: top ? +top.driveCosine.toFixed(3) : null,
      alpha,
      ruminationSuppressRemaining: this.ruminationSuppressRemaining,
      bufferCount: this.count,
    });

    return results;
  }

  /**
   * WS5 T2.5 — inspectable rumination-breaker state for a future gate row.
   * Read-only snapshot; never mutates drives or evaluation (Std 6).
   */
  getRuminationState(): {
    suppressRemaining: number;
    tripCount: number;
    lastTripAt: string | null;
    windowSize: number;
    congruentInWindow: number;
    distinctInWindow: number;
  } {
    const congruent = this.ruminationWindow.filter((w) => w.moodCongruent).length;
    const distinct = new Set(
      this.ruminationWindow.map((w) => w.topEpisodeId).filter((id): id is string => id !== null),
    ).size;
    return {
      suppressRemaining: this.ruminationSuppressRemaining,
      tripCount: this.ruminationTripCount,
      lastTripAt: this.lastRuminationTripAt ? this.lastRuminationTripAt.toISOString() : null,
      windowSize: this.ruminationWindow.length,
      congruentInWindow: congruent,
      distinctInWindow: distinct,
    };
  }

  // ---------------------------------------------------------------------------
  // IEpisodicMemoryService — getEpisodeCount
  // ---------------------------------------------------------------------------

  /**
   * Return the total number of episodes currently stored in the ring buffer.
   *
   * @returns Non-negative integer in [0, RING_BUFFER_CAPACITY].
   */
  getEpisodeCount(): number {
    return this.count;
  }

  /**
   * Clear all episodes from the ring buffer (e.g., on system reset).
   * WS5 T2.5 — also resets the rumination-breaker window/cooldown so a gate run
   * starts from a known cold breaker state (hermeticity).
   */
  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.count = 0;
    this.ruminationWindow.length = 0;
    this.ruminationSuppressRemaining = 0;
    // NOTE: tripCount / lastTripAt are lifetime audit counters — deliberately
    // NOT zeroed here so the process-lifetime trip history survives a buffer
    // reset. A gate that needs a zeroed trip count restarts the process.
    this.logger.debug('Episodic memory cleared.');
  }

  // ---------------------------------------------------------------------------
  // Private — event emission
  // ---------------------------------------------------------------------------

  /**
   * Emit a EPISODE_ENCODED event via the optional event logger.
   * Safe to call when eventLogger is null — the call is silently skipped.
   */
  private emitEpisodeEncoded(episode: Episode, driveSnapshot: DriveSnapshot): void {
    if (!this.eventLogger) return;

    try {
      this.eventLogger.log(
        'EPISODE_ENCODED',
        {
          episodeId: episode.id,
          encodingDepth: episode.encodingDepth,
          ageWeight: episode.ageWeight,
          contextFingerprint: episode.contextFingerprint,
          bufferCount: this.count,
        },
        driveSnapshot,
        driveSnapshot.sessionId,
      );
    } catch (err) {
      this.logger.warn(`Failed to emit EPISODE_ENCODED event: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // WS5 T2.5 — rumination circuit-breaker evaluation
  // ---------------------------------------------------------------------------

  /**
   * Record one queryByContent retrieval into the sliding window and evaluate the
   * breaker. A retrieval is "mood-congruent" iff a query mood was supplied AND
   * the top result's drive-cosine to it exceeds RUMINATION_CONGRUENT_COSINE.
   *
   * Trip condition (ashby): over the last RUMINATION_WINDOW retrievals, if
   * ≥ RUMINATION_MIN_CONGRUENT are mood-congruent AND ≤ RUMINATION_MAX_DISTINCT
   * distinct episode ids appear → TRIP. On trip: force α→0 for the next K
   * retrievals (set ruminationSuppressRemaining = K), WRITE NOTHING TO DRIVES
   * (Std 6), and emit a gate-assertable RUMINATION_BREAKER_TRIPPED event.
   *
   * The K-cooldown decrement happens here too (one retrieval = one step), so the
   * suppression spans exactly the next K retrievals after the trip.
   */
  private recordRetrievalForBreaker(
    topEpisodeId: string | null,
    topDriveCosine: number,
    queryMood: DriveSnapshot | undefined,
  ): void {
    // Step the cooldown first: this retrieval consumes one suppressed slot.
    if (this.ruminationSuppressRemaining > 0) {
      this.ruminationSuppressRemaining--;
    }

    const moodCongruent =
      queryMood !== undefined && topDriveCosine >= RUMINATION_CONGRUENT_COSINE;

    this.ruminationWindow.push({ topEpisodeId, moodCongruent });
    if (this.ruminationWindow.length > RUMINATION_WINDOW) {
      this.ruminationWindow.shift();
    }

    // Only evaluate a full window — a partial window can't satisfy ≥8/10.
    if (this.ruminationWindow.length < RUMINATION_WINDOW) return;
    // Already suppressing → don't re-trip mid-cooldown (avoids a self-perpetuating
    // trip cascade; the window keeps filling and re-evaluates once cooldown ends).
    if (this.ruminationSuppressRemaining > 0) return;

    const congruent = this.ruminationWindow.filter((w) => w.moodCongruent).length;
    const distinct = new Set(
      this.ruminationWindow.map((w) => w.topEpisodeId).filter((id): id is string => id !== null),
    ).size;

    if (congruent >= RUMINATION_MIN_CONGRUENT && distinct <= RUMINATION_MAX_DISTINCT) {
      this.ruminationSuppressRemaining = RUMINATION_SUPPRESS_K;
      this.ruminationTripCount++;
      this.lastRuminationTripAt = new Date();
      this.logger.warn(
        `Rumination circuit-breaker TRIPPED: ${congruent}/${RUMINATION_WINDOW} mood-congruent, ` +
          `${distinct} distinct episode(s) in window. Forcing alpha→0 for ${RUMINATION_SUPPRESS_K} ` +
          `retrievals (Std 6 — no drive write).`,
      );
      this.emitRuminationTripped(congruent, distinct);
    }
  }

  /**
   * Emit the gate-assertable RUMINATION_BREAKER_TRIPPED event. Std 6: this is an
   * AUDIT event only — it carries the breaker diagnostics, never a drive write.
   * The drive snapshot attached is the LAST retrieval's mood (for correlation),
   * never a modified one. Safe when eventLogger is null.
   */
  private emitRuminationTripped(congruent: number, distinct: number): void {
    if (!this.eventLogger) return;
    // Use the most recent episode's drive snapshot for event correlation context
    // if one exists; otherwise skip (the event logger requires a snapshot).
    const recent = this.getRecentEpisodes(1);
    const snapshot = recent[0]?.driveSnapshot;
    if (!snapshot) return;
    try {
      this.eventLogger.log(
        'RUMINATION_BREAKER_TRIPPED',
        {
          congruentInWindow: congruent,
          distinctInWindow: distinct,
          window: RUMINATION_WINDOW,
          suppressK: RUMINATION_SUPPRESS_K,
          tripCount: this.ruminationTripCount,
        },
        snapshot,
        snapshot.sessionId,
      );
    } catch (err) {
      this.logger.warn(`Failed to emit RUMINATION_BREAKER_TRIPPED event: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pure utility functions (not injectable — no state)
// ---------------------------------------------------------------------------

/**
 * Tokenise a context fingerprint string into a Set of lowercase tokens.
 * Splits on any whitespace sequence; filters empty strings.
 */
function tokenise(fingerprint: string): Set<string> {
  return new Set(fingerprint.toLowerCase().split(/\s+/).filter(Boolean));
}

/**
 * Compute Jaccard similarity between two token sets.
 *
 * Jaccard(A, B) = |A ∩ B| / |A ∪ B|
 * Returns 0 when both sets are empty (no meaningful comparison possible).
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of a) {
    if (b.has(token)) intersectionSize++;
  }

  const unionSize = a.size + b.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * WS5 T2.2 — Overlap coefficient (Szymkiewicz–Simpson): |A ∩ B| / min(|A|, |B|).
 *
 * Used by the CONTENT recall path instead of symmetric Jaccard so a short NL
 * query fully contained in a verbose stored caption scores ~1.0 regardless of
 * the caption's length (union inflation does not penalize containment). Returns
 * 0 when either set is empty — a query that reduces to zero content tokens after
 * stopword filtering (e.g. "what do you see?") matches NOTHING, which is correct:
 * with no content noun there is no content to recall on.
 */
function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersectionSize = 0;
  for (const token of a) {
    if (b.has(token)) intersectionSize++;
  }
  return intersectionSize / Math.min(a.size, b.size);
}

// ---------------------------------------------------------------------------
// WS5 T2 — CONTENT-recall helpers (separate from the SHA-fingerprint tokenizer)
// ---------------------------------------------------------------------------

/**
 * Stopwords stripped from BOTH the query and episode content before the content
 * Jaccard. This is the calibration that makes NL-vs-caption recall discriminate:
 * without it, query articles/verbs ("did you see a … earlier") share tokens with
 * every caption ("a … on the …") and a wrong-noun query still scores ~0.1. With
 * it, the discriminating signal is the content noun, so the worst positive (0.14)
 * and the best negative (0.00) separate cleanly (see CONTENT_SIMILARITY_THRESHOLD).
 * Deliberately scoped to recall-query/caption function words — NOT a general NLP
 * stoplist (kept small and auditable).
 */
const CONTENT_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'did', 'do', 'does', 'you', 'i', 'me', 'my', 'your', 'we',
  'see', 'saw', 'seen', 'was', 'is', 'are', 'be', 'been', 'have', 'had', 'has',
  'what', 'who', 'when', 'where', 'why', 'how', 'earlier', 'before', 'ago',
  'recently', 'on', 'in', 'at', 'of', 'to', 'and', 'or', 'that', 'this', 'it',
  'there', 'here', 'any', 'some', 'with', 'for', 'about', 'tell', 'show',
  // bracketed category prefixes the summarizer prepends, post punctuation-strip:
  'visual', 'input', 'entities', 'entity',
]);

/**
 * Tokenise free-text content for the recall path: lowercase, strip punctuation,
 * split on whitespace, drop stopwords. Used for BOTH the query and the episode
 * content blob so the comparison is symmetric.
 */
function tokeniseContent(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter((t) => !CONTENT_STOPWORDS.has(t)),
  );
}

/**
 * Assemble an episode's recall-matchable CONTENT string: the VLM caption text +
 * the SENSOR scene labels + the human-readable inputSummary. This is what a
 * free-text query is matched against — "what did you see?" recalls on what she
 * saw, not on the SHA fingerprint. Absent visualContext (text/legacy episodes)
 * contributes only the inputSummary, so a text episode is matchable too but a
 * vision episode carries its caption/labels into the match (T1.3 — absence is
 * treated as a text episode, never a crash).
 */
function contentBlob(episode: Episode): string {
  const parts: string[] = [];
  const vc = episode.visualContext;
  if (vc?.caption?.text) parts.push(vc.caption.text);
  if (vc?.sceneLabels && vc.sceneLabels.length > 0) parts.push(vc.sceneLabels.join(' '));
  if (episode.inputSummary) parts.push(episode.inputSummary);
  return parts.join(' ');
}

/**
 * WS5 T2.5 — cosine similarity between two drive pressure vectors, over the
 * canonical DRIVE_INDEX_ORDER so both vectors are aligned dimension-for-dimension.
 * Returns 0 when either vector has zero magnitude (a fully-cold drive state has
 * no mood to be congruent with). Range clamped to [0, 1] for the blend (negative
 * cosines — opposite moods — contribute no boost rather than a penalty).
 */
function driveCosineSimilarity(a: DriveSnapshot, b: DriveSnapshot): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const drive of DRIVE_INDEX_ORDER) {
    const va = a.pressureVector[drive as DriveName] ?? 0;
    const vb = b.pressureVector[drive as DriveName] ?? 0;
    dot += va * vb;
    magA += va * va;
    magB += vb * vb;
  }
  if (magA === 0 || magB === 0) return 0;
  const cos = dot / (Math.sqrt(magA) * Math.sqrt(magB));
  return cos < 0 ? 0 : cos > 1 ? 1 : cos;
}

/**
 * WS5 T2.4 — recall-local recency-decay multiplier in (0, 1].
 * 2^(-ageHours / RECALL_RECENCY_HALFLIFE_HOURS): a just-encoded episode → 1.0,
 * one half-life old → 0.5, etc. Applied ONLY to effectiveWeight inside
 * queryByContent's sort comparator; never written back to episode.ageWeight.
 */
function recencyDecay(ageHours: number): number {
  return Math.pow(2, -ageHours / RECALL_RECENCY_HALFLIFE_HOURS);
}
