/**
 * ResearchService -- Gathers evidence from TimescaleDB for a given opportunity.
 *
 * CANON SS Subsystem 5 (Planning): "Research Opportunity" reads event frequency
 * from TimescaleDB to determine whether the opportunity has enough supporting
 * evidence to warrant a plan.
 *
 * Queries:
 *   1. Count events matching the opportunity's classification in the last 7 days.
 *   2. Count events in the last 24 hours (recency signal).
 *   3. Fetch related event summaries for context extraction.
 *
 * Sufficiency thresholds:
 *   - PREDICTION_FAILURE_PATTERN: >= 3 occurrences
 *   - HIGH_IMPACT_ONE_OFF: >= 1 occurrence
 *   - BEHAVIORAL_NARROWING: >= 3 occurrences
 *   - GUARDIAN_TEACHING: always sufficient (guardian explicitly initiated)
 */

import { Injectable, Logger } from '@nestjs/common';
import { TimescaleService } from '@sylphie/shared';
import type {
  IResearchService,
  ResearchResult,
  EventSummary,
  QueuedOpportunity,
} from '../interfaces/planning.interfaces';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum event occurrences for sufficiency, by classification. */
const SUFFICIENCY_THRESHOLDS: Record<string, number> = {
  PREDICTION_FAILURE_PATTERN: 3,
  HIGH_IMPACT_ONE_OFF: 1,
  BEHAVIORAL_NARROWING: 3,
  GUARDIAN_TEACHING: 0,
};

/** Maximum related events to fetch for context. */
const MAX_RELATED_EVENTS = 20;

/** Research window in days. */
const RESEARCH_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ResearchService implements IResearchService {
  private readonly logger = new Logger(ResearchService.name);

  constructor(private readonly timescale: TimescaleService) {}

  async research(opportunity: QueuedOpportunity): Promise<ResearchResult> {
    const { classification, contextFingerprint, affectedDrive } = opportunity.payload;

    try {
      // Query 1: Total event frequency in research window.
      const frequencyResult = await this.timescale.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM events
         WHERE timestamp > NOW() - INTERVAL '${RESEARCH_WINDOW_DAYS} days'
           AND payload->>'contextFingerprint' = $1`,
        [contextFingerprint],
      );
      const eventFrequency = parseInt(frequencyResult[0]?.count ?? '0', 10);

      // Query 2: Recent occurrences (last 24h).
      const recentResult = await this.timescale.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM events
         WHERE timestamp > NOW() - INTERVAL '1 day'
           AND payload->>'contextFingerprint' = $1`,
        [contextFingerprint],
      );
      const recentOccurrences = parseInt(recentResult[0]?.count ?? '0', 10);

      // Query 3: Related event summaries for pattern extraction.
      const relatedRows = await this.timescale.query<{
        id: string;
        type: string;
        timestamp: Date;
        payload: string;
      }>(
        `SELECT id, type, timestamp, payload FROM events
         WHERE timestamp > NOW() - INTERVAL '${RESEARCH_WINDOW_DAYS} days'
           AND payload->>'contextFingerprint' = $1
         ORDER BY timestamp DESC
         LIMIT $2`,
        [contextFingerprint, MAX_RELATED_EVENTS],
      );

      const relatedEvents: EventSummary[] = relatedRows.map((row) => ({
        eventId: row.id,
        type: row.type,
        timestamp: new Date(row.timestamp),
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      }));

      // Extract context patterns from event payloads.
      const contextPatterns = this.extractPatterns(relatedEvents);

      // Determine sufficiency.
      const threshold = SUFFICIENCY_THRESHOLDS[classification] ?? 3;
      const sufficient = eventFrequency >= threshold;

      this.logger.debug(
        `Research for ${opportunity.payload.id}: frequency=${eventFrequency}, ` +
          `recent=${recentOccurrences}, sufficient=${sufficient} ` +
          `(threshold=${threshold} for ${classification})`,
      );

      return {
        sufficient,
        eventFrequency,
        recentOccurrences,
        relatedEvents,
        contextPatterns,
      };
    } catch (err) {
      this.logger.error(
        `Research failed for opportunity ${opportunity.payload.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // On error, return insufficient to avoid proceeding with bad data.
      return {
        sufficient: false,
        eventFrequency: 0,
        recentOccurrences: 0,
        relatedEvents: [],
        contextPatterns: [],
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Extract semantic patterns from related event payloads.
   * Deduplicates and returns unique pattern strings.
   */
  private extractPatterns(events: readonly EventSummary[]): string[] {
    const patterns = new Set<string>();

    for (const event of events) {
      // Extract action types from payloads.
      const actionType = event.payload['actionType'];
      if (typeof actionType === 'string') {
        patterns.add(`action:${actionType}`);
      }

      // Extract prediction types.
      const predictionType = event.payload['predictionType'];
      if (typeof predictionType === 'string') {
        patterns.add(`prediction:${predictionType}`);
      }

      // Extract affected drives.
      const drive = event.payload['affectedDrive'];
      if (typeof drive === 'string') {
        patterns.add(`drive:${drive}`);
      }
    }

    return Array.from(patterns);
  }
}
