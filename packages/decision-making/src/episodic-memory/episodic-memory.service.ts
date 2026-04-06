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

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  type Episode,
  type EpisodeInput,
  type EncodingDepth,
  type DriveSnapshot,
} from '@sylphie/shared';
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

/** Encoding gate threshold. Either attention or arousal must exceed this. */
const ENCODING_GATE_THRESHOLD = 0.60;

/** Jaccard similarity threshold for queryByContext() to include a result. */
const CONTEXT_SIMILARITY_THRESHOLD = 0.70;

// ---------------------------------------------------------------------------
// EpisodicMemoryService
// ---------------------------------------------------------------------------

@Injectable()
export class EpisodicMemoryService implements IEpisodicMemoryService {
  private readonly logger = new Logger(EpisodicMemoryService.name);

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

  constructor(
    @Optional()
    @Inject(DECISION_EVENT_LOGGER)
    private readonly eventLogger: IDecisionEventLogger | null,
  ) {}

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
      timestamp: new Date(),
      driveSnapshot: input.driveSnapshot,
      inputSummary: input.inputSummary,
      actionTaken: input.actionTaken,
      predictionIds: [],
      ageWeight,
      encodingDepth: effectiveDepth,
      contextFingerprint: input.contextFingerprint,
    };

    // Write to the ring buffer at head, then advance.
    this.buffer[this.head] = episode;
    this.head = (this.head + 1) % RING_BUFFER_CAPACITY;
    this.count = Math.min(this.count + 1, RING_BUFFER_CAPACITY);

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
   * Query episodes by context fingerprint similarity using Jaccard similarity.
   *
   * Tokenises both the query fingerprint and each stored episode's fingerprint
   * by splitting on whitespace, then computes the Jaccard coefficient
   * (|intersection| / |union|). Episodes with Jaccard > 0.70 are included.
   *
   * Results are sorted by ageWeight descending (highest weight = most recent
   * and most attentionally salient).
   *
   * @param contextFingerprint - The fingerprint to query against.
   * @param limit              - Maximum results to return. Defaults to 5.
   * @returns Read-only array of matching episodes, sorted by ageWeight desc.
   */
  queryByContext(contextFingerprint: string, limit = 5): readonly Episode[] {
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
    matches.sort((a, b) => {
      const weightDiff = b.episode.ageWeight - a.episode.ageWeight;
      return weightDiff !== 0 ? weightDiff : b.similarity - a.similarity;
    });

    return matches.slice(0, limit).map((m) => m.episode);
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
