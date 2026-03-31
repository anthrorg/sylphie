/**
 * EventRankerService — assigns salience scores to learnable events.
 *
 * Implements IEventRankerService. Ranks LearnableEvents by salience based on
 * recency, guardian feedback presence, and drive state. Higher scores indicate
 * higher priority for consolidation in the next cycle.
 *
 * CANON §Subsystem 3 (Learning): Salience combines recency, guardian feedback,
 * and drive state to prioritize high-value learning events for limited cycle
 * budget (max 5 events per cycle).
 *
 * Salience Algorithm (per E7-T004):
 * - Guardian corrections: +0.50
 * - Guardian teachings (via 'correction' proxy): +0.40
 * - Guardian confirmations: +0.20
 * - Prediction failures: +0.30
 * - Novel entities: +0.25
 * - Recency boost: Math.max(0, 0.15 - hoursAgo * 0.01) [decaying, more recent = higher]
 * - Total: sum of applicable boosts, capped at 1.0
 *
 * Returns scores sorted descending by totalScore.
 */

import { Injectable, Logger } from '@nestjs/common';

import type { LearnableEvent } from '../../shared/types/event.types';
import type {
  IEventRankerService,
  SalienceScore,
} from '../interfaces/learning.interfaces';

@Injectable()
export class EventRankerService implements IEventRankerService {
  private readonly logger = new Logger(EventRankerService.name);

  /**
   * Rank a set of LearnableEvents by salience.
   *
   * Computes salience for each event based on guardian feedback, prediction
   * signals, novelty, and recency. Returns parallel array of SalienceScore
   * objects sorted descending by totalScore.
   *
   * Pure computation: no database access.
   *
   * @param events - Events to rank.
   * @returns Array of salience scores parallel to events, sorted by totalScore descending.
   */
  rankBySalience(events: readonly LearnableEvent[]): SalienceScore[] {
    const scores: SalienceScore[] = events.map((event) => {
      const baseSalience = this.computeBaseSalience(event);
      const recencyBoost = this.computeRecencyBoost(event.timestamp);
      const totalScore = Math.min(1.0, baseSalience + recencyBoost);

      return {
        eventId: event.id,
        baseSalience,
        recencyBoost,
        totalScore,
      };
    });

    // Sort descending by totalScore
    return scores.sort((a, b) => b.totalScore - a.totalScore);
  }

  /**
   * Compute base salience from guardian feedback and prediction signals.
   * Does not include recency.
   *
   * @param event - The learnable event to score.
   * @returns Base salience in [0.0, 1.0].
   */
  private computeBaseSalience(event: LearnableEvent): number {
    let score = 0.0;

    // Guardian feedback weights (Guardian Asymmetry per CANON Standard 5)
    if (event.guardianFeedbackType === 'correction') {
      // Corrections get highest weight: +0.50
      score += 0.5;
    } else if (event.guardianFeedbackType === 'confirmation') {
      // Confirmations: +0.20
      score += 0.2;
    }
    // 'none' contributes nothing to base salience

    // Prediction failures: +0.30
    // Detect if this event has prediction-related signals.
    // Per spec: "check if event has prediction-related data"
    // Events with prediction evaluation or accuracy data get boost.
    if (this.hasPredictionSignal(event)) {
      score += 0.3;
    }

    // Novel entities: +0.25
    // Detect novel content signals (e.g., new or unfamiliar entities mentioned).
    // Per spec: "check for novel content signals"
    if (this.hasNovelContent(event)) {
      score += 0.25;
    }

    // Cap at 1.0 before adding recency
    return Math.min(1.0, score);
  }

  /**
   * Compute recency boost: newer events get higher boost.
   * Formula: Math.max(0, 0.15 - hoursAgo * 0.01)
   * This decays over time but caps at 0, never going negative.
   *
   * @param eventTimestamp - The event's creation timestamp.
   * @returns Recency boost in [0.0, 0.15].
   */
  private computeRecencyBoost(eventTimestamp: Date): number {
    const now = new Date();
    const millisAgo = now.getTime() - eventTimestamp.getTime();
    const hoursAgo = millisAgo / (1000 * 60 * 60);

    // Decaying boost: max 0.15, decreases by 0.01 per hour
    return Math.max(0, 0.15 - hoursAgo * 0.01);
  }

  /**
   * Heuristic: does this event contain signals of prediction failure or evaluation?
   *
   * In a full system, this would check for correlationId linking to
   * PREDICTION_EVALUATED events or similar. For now, use content heuristics:
   * - Look for keywords suggesting prediction context or failure
   * - Check provenance and drive state if available
   *
   * @param event - The event to check.
   * @returns True if prediction signals are detected.
   */
  private hasPredictionSignal(event: LearnableEvent): boolean {
    // Simple heuristic: look for prediction-related keywords in content
    const lowerContent = event.content.toLowerCase();
    const predictionKeywords = [
      'expect',
      'predict',
      'should',
      'would',
      'likely',
      'probable',
      'wrong',
      'mistake',
      'failed',
      'accurate',
      'error',
    ];

    return predictionKeywords.some((keyword) =>
      lowerContent.includes(keyword),
    );
  }

  /**
   * Heuristic: does this event contain signals of novel content or unfamiliar entities?
   *
   * In a full system, this would check against the WKG for unknown entities.
   * For now, use content-based heuristics:
   * - Look for proper nouns or new names (capitalized words)
   * - Check for exploratory language
   * - Check if content contains unfamiliar patterns
   *
   * @param event - The event to check.
   * @returns True if novelty signals are detected.
   */
  private hasNovelContent(event: LearnableEvent): boolean {
    // Simple heuristic: look for capitalized words (potential proper nouns)
    // and exploratory language
    const words = event.content.split(/\s+/);
    const capitalizedWords = words.filter(
      (w) => w.length > 0 && /^[A-Z]/.test(w),
    );

    // If more than 20% of words are capitalized, likely contains new entities
    const noveltyRatio = capitalizedWords.length / Math.max(1, words.length);

    // Also check for explicit novelty language
    const lowerContent = event.content.toLowerCase();
    const noveltyKeywords = [
      'new',
      'novel',
      'first',
      'never',
      'unknown',
      'unfamiliar',
      'discovered',
      'found',
      'learned',
    ];
    const hasNoveltyLanguage = noveltyKeywords.some((keyword) =>
      lowerContent.includes(keyword),
    );

    // Return true if novelty ratio is high OR explicit language present
    return noveltyRatio > 0.2 || hasNoveltyLanguage;
  }
}
