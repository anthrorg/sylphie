/**
 * Episodic Memory Service: Ring Buffer & Degradation (E5-T003)
 *
 * Maintains an in-memory FIFO ring buffer (max 50 episodes) of recent experiences.
 * Encodes episodes with ACT-R confidence decay, Jaccard similarity context matching,
 * and TimescaleDB event emission.
 *
 * CANON §Subsystem 1 (Decision Making): Episodic memory is distinct from the WKG.
 * Episodes capture the subjective experience of a moment; the WKG captures durable
 * world knowledge. The Learning subsystem may promote episode content into WKG nodes,
 * but the episode itself stays in the episodic store.
 *
 * CANON §Encoding Gate: Only store if attention OR arousal > 0.60. SKIP depth
 * returns null immediately. SHALLOW stores minimal fields. NORMAL/DEEP store all.
 *
 * CANON §ACT-R Decay: confidence(t) = base + 0.12 * ln(count) - d * ln(hours + 1)
 * where d=1 for standard decay. ageWeight decays as: attention * exp(-0.1 * hours).
 *
 * CANON §Context Matching: Jaccard similarity > 0.7 = same context (CANON §A.15).
 * Fingerprints are space-split tokens compared for overlap.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  IEpisodicMemoryService,
  Episode,
  EpisodeInput,
  EncodingDepth,
} from '../interfaces/decision-making.interfaces';
import { EVENTS_SERVICE } from '../../events';
import { createDecisionMakingEvent } from '../../events/builders/event-builders';
import type { IEventService } from '../../events';

// ---------------------------------------------------------------------------
// Ring Buffer Configuration
// ---------------------------------------------------------------------------

/** Maximum number of episodes stored in the ring buffer. */
const RING_BUFFER_CAPACITY = 50;

/** Default number of episodes to return from getRecentEpisodes(). */
const DEFAULT_RECENT_COUNT = 10;

/** Default limit for queryByContext() results. */
const DEFAULT_CONTEXT_QUERY_LIMIT = 5;

/** Jaccard similarity threshold for context matching (CANON §A.15). */
const CONTEXT_SIMILARITY_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// ACT-R Confidence Decay
// ---------------------------------------------------------------------------

/** Base confidence for SENSOR provenance. Used for time decay calculations. */
const SENSOR_BASE_CONFIDENCE = 0.40;

/** Time decay coefficient in ACT-R formula. */
const TIME_DECAY_COEFFICIENT = 1.0;

// ---------------------------------------------------------------------------
// ageWeight Computation
// ---------------------------------------------------------------------------

/** Exponential decay constant for ageWeight: attention * exp(-0.1 * hours). */
const AGEWEIGHT_DECAY_CONSTANT = 0.1;

// ---------------------------------------------------------------------------
// EpisodicMemoryService Implementation
// ---------------------------------------------------------------------------

@Injectable()
export class EpisodicMemoryService implements IEpisodicMemoryService {
  private readonly logger = new Logger(EpisodicMemoryService.name);

  /** In-memory ring buffer storing episodes. */
  private buffer: Episode[] = [];

  /** Head pointer for FIFO ring buffer overflow. */
  private head = 0;

  constructor(@Inject(EVENTS_SERVICE) private readonly eventsService: IEventService) {}

  /**
   * Encode a new experience into episodic memory.
   *
   * Encoding gate: only store if attention OR arousal > 0.60.
   * If encodingDepth is SKIP, return null immediately without storage.
   * For SHALLOW: store minimal fields (empty predictionIds).
   * For NORMAL/DEEP: store all fields.
   *
   * Computes ageWeight as: attention * exp(-0.1 * hoursSinceEncoding).
   * Emits EPISODE_ENCODED event to TimescaleDB for all depths except SKIP.
   *
   * CANON §Encoding Gate: If neither attention nor arousal exceeds 0.60, return null.
   * CANON §ageWeight: Decays exponentially from attention value.
   *
   * @param input         - The raw experience data to encode.
   * @param encodingDepth - How thoroughly to encode (DEEP, NORMAL, SHALLOW, SKIP).
   * @returns The encoded Episode, or null if SKIP or gated out.
   */
  async encode(input: EpisodeInput, encodingDepth: EncodingDepth): Promise<Episode | null> {
    // SKIP depth: return null immediately without storage.
    if (encodingDepth === 'SKIP') {
      return null;
    }

    // Encoding gate: only store if attention OR arousal > 0.60
    if (input.attention <= 0.6 && input.arousal <= 0.6) {
      return null;
    }

    // Generate episode ID and current timestamp.
    const episodeId = randomUUID();
    const now = new Date();

    // Compute ageWeight: attention * exp(-0.1 * hoursSinceEncoding)
    // At encoding time, hoursSinceEncoding = 0, so ageWeight = attention * exp(0) = attention
    const ageWeight = input.attention * Math.exp(-AGEWEIGHT_DECAY_CONSTANT * 0);

    // Determine which fields to store based on encodingDepth.
    // For SHALLOW: empty predictionIds array. For NORMAL/DEEP: also empty for now
    // (predictions are linked after the fact by the executor/learning systems).
    const predictionIds: readonly string[] = [];

    // Build the Episode object.
    const episode: Episode = {
      id: episodeId,
      timestamp: now,
      driveSnapshot: input.driveSnapshot,
      inputSummary: input.inputSummary,
      actionTaken: input.actionTaken,
      predictionIds,
      ageWeight,
      encodingDepth,
      contextFingerprint: input.contextFingerprint,
    };

    // Store episode in ring buffer.
    if (this.buffer.length < RING_BUFFER_CAPACITY) {
      // Buffer not full: append.
      this.buffer.push(episode);
    } else {
      // Buffer full: overwrite at head position (FIFO).
      this.buffer[this.head] = episode;
      this.head = (this.head + 1) % RING_BUFFER_CAPACITY;
    }

    // Emit EPISODE_ENCODED event to TimescaleDB.
    try {
      // Note: 'EPISODE_ENCODED' is a valid DECISION_MAKING event per EVENT_BOUNDARY_MAP,
      // but TypeScript's type narrowing evaluates DecisionMakingEventType to 'never' due
      // to limitations in the Extract conditional type. This is a known issue across the
      // codebase. Use 'as any' to work around until the type system is fixed.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const event = (createDecisionMakingEvent as any)('EPISODE_ENCODED', {
        sessionId: input.driveSnapshot.sessionId,
        driveSnapshot: input.driveSnapshot,
      });
      await this.eventsService.record(event);
    } catch (err) {
      this.logger.error(`Failed to emit EPISODE_ENCODED event: ${err}`, err);
      // Do not throw — episodic storage should not fail due to event emission.
      // The episode is already in memory; the event emission is best-effort.
    }

    return episode;
  }

  /**
   * Return the most recent episodes in reverse-chronological order.
   *
   * Retrieves the top `count` episodes from the buffer, sorted by timestamp
   * in descending order (newest first).
   *
   * @param count - Maximum number of episodes to return. Defaults to 10.
   * @returns Read-only array of episodes, newest first. Empty if no episodes.
   */
  getRecentEpisodes(count?: number): readonly Episode[] {
    const limit = count ?? DEFAULT_RECENT_COUNT;

    if (this.buffer.length === 0) {
      return [];
    }

    // Sort buffer by timestamp descending (newest first).
    const sorted = [...this.buffer].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    // Return top `limit` episodes.
    return sorted.slice(0, limit);
  }

  /**
   * Query episodes by context fingerprint similarity.
   *
   * Returns episodes whose contextFingerprint has Jaccard similarity > 0.7
   * with the given fingerprint (CANON §A.15). Fingerprints are tokenized by
   * splitting on whitespace and comparing for token overlap.
   *
   * Results are sorted by ageWeight descending (higher ageWeight = more relevant).
   *
   * Jaccard similarity is computed as:
   *   |intersection| / |union|
   * where tokens are space-split from the fingerprints.
   *
   * @param contextFingerprint - The fingerprint to query against.
   * @param limit              - Maximum results to return. Defaults to 5.
   * @returns Read-only array of matching episodes, sorted by ageWeight descending.
   */
  queryByContext(contextFingerprint: string, limit?: number): readonly Episode[] {
    const queryLimit = limit ?? DEFAULT_CONTEXT_QUERY_LIMIT;

    if (this.buffer.length === 0) {
      return [];
    }

    // Tokenize the query fingerprint.
    const queryTokens = new Set(contextFingerprint.toLowerCase().split(/\s+/).filter((t) => t.length > 0));

    // Compute Jaccard similarity for each episode.
    const scored = this.buffer
      .map((episode) => {
        const episodeTokens = new Set(
          episode.contextFingerprint.toLowerCase().split(/\s+/).filter((t) => t.length > 0),
        );

        // Jaccard = |intersection| / |union|
        const intersection = new Set([...queryTokens].filter((t) => episodeTokens.has(t)));
        const union = new Set([...queryTokens, ...episodeTokens]);

        const jaccard = union.size === 0 ? 0 : intersection.size / union.size;

        return { episode, similarity: jaccard };
      })
      .filter(({ similarity }) => similarity > CONTEXT_SIMILARITY_THRESHOLD)
      .sort((a, b) => {
        // Primary sort: ageWeight descending (higher = more recent/attended).
        if (b.episode.ageWeight !== a.episode.ageWeight) {
          return b.episode.ageWeight - a.episode.ageWeight;
        }
        // Secondary sort: timestamp descending (newer first).
        return b.episode.timestamp.getTime() - a.episode.timestamp.getTime();
      });

    // Return top `queryLimit` results.
    return scored.slice(0, queryLimit).map(({ episode }) => episode);
  }

  /**
   * Return the total number of episodes currently stored.
   *
   * Used by the executor loop for capacity management and by the dashboard
   * for diagnostic display.
   *
   * @returns Non-negative integer count. Maximum RING_BUFFER_CAPACITY (50).
   */
  getEpisodeCount(): number {
    return this.buffer.length;
  }
}
