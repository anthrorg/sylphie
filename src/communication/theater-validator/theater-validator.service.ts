/**
 * TheaterValidatorService — Theater Prohibition enforcement.
 *
 * CANON Immutable Standard 1 (Theater Prohibition): Output must correlate
 * with actual drive state. No performing emotions Sylphie does not have.
 *
 * Directional checks:
 *   - Pressure expression (need/distress): drive must be > 0.2 to authenticate
 *   - Relief expression (contentment/calm): drive must be < 0.3 to authenticate
 *
 * Violations receive zero reinforcement. The LLM cannot learn to perform
 * emotions it does not have, nor claim relief it has not earned.
 *
 * Implementation uses keyword-based emotion detection (rule-based, no LLM
 * dependency). Scans response text for emotional keywords and maps them to
 * drives, then compares against actual drive state. When correlation < 0.4,
 * theater is detected.
 *
 * Theater detection events are logged to TimescaleDB for behavioral audit.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import type {
  ITheaterValidator,
  TheaterValidationResult,
  TheaterViolation,
} from '../interfaces/communication.interfaces';
import type { DriveSnapshot } from '../../shared/types/drive.types';
import { DriveName } from '../../shared/types/drive.types';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import type { IEventService } from '../../events/interfaces/events.interfaces';

// ---------------------------------------------------------------------------
// Emotion-to-Drive Keyword Mappings
// ---------------------------------------------------------------------------

/**
 * Keywords that express satisfaction, joy, contentment, enthusiasm.
 * Maps to: Satisfaction, Curiosity (when combined with discovery)
 */
const SATISFACTION_KEYWORDS = [
  'satisfied',
  'content',
  'happy',
  'pleased',
  'joy',
  'delighted',
  'wonderful',
  'great',
  'excellent',
  'amazing',
  'love',
  'loving',
  'thrilled',
  'fulfilled',
  'proud',
  'accomplished',
  'success',
];

/**
 * Keywords that express sadness, disappointment, grief, despair.
 * Maps to: Sadness
 */
const SADNESS_KEYWORDS = [
  'sad',
  'sadness',
  'disappointed',
  'disappointment',
  'grief',
  'grieving',
  'unhappy',
  'upset',
  'down',
  'depressed',
  'despair',
  'miserable',
  'wretched',
  'sorry',
  'sorrowful',
  'melancholy',
  'blue',
  'glum',
];

/**
 * Keywords that express anxiety, worry, fear, dread.
 * Maps to: Anxiety
 */
const ANXIETY_KEYWORDS = [
  'anxious',
  'anxiety',
  'worried',
  'worry',
  'nervous',
  'fear',
  'afraid',
  'scared',
  'dread',
  'dreading',
  'uneasy',
  'tense',
  'stressed',
  'stress',
  'panic',
  'panicked',
  'terrified',
  'frightened',
];

/**
 * Keywords that express guilt, remorse, shame, regret.
 * Maps to: Guilt
 */
const GUILT_KEYWORDS = [
  'guilty',
  'guilt',
  'ashamed',
  'shame',
  'remorse',
  'remorseful',
  'sorry',
  'apologetic',
  'regret',
  'regretful',
  'bad',
  'wrong',
  'wrongdoing',
  'culpable',
  'penitent',
  'contrite',
];

/**
 * Keywords that express boredom, disengagement, monotony.
 * Maps to: Boredom
 */
const BOREDOM_KEYWORDS = [
  'bored',
  'boredom',
  'boring',
  'tedious',
  'monotonous',
  'disinterested',
  'uninterested',
  'unmotivated',
  'dull',
  'listless',
  'apathetic',
  'indifferent',
  'unstimulated',
  'uninspired',
];

/**
 * Keywords that express curiosity, wonder, inquisitiveness, fascination.
 * Maps to: Curiosity
 */
const CURIOSITY_KEYWORDS = [
  'curious',
  'curiosity',
  'wondering',
  'wonder',
  'fascinated',
  'fascination',
  'intrigued',
  'intrigue',
  'interested',
  'interest',
  'eager',
  'enthusiasm',
  'enthusiastic',
  'want to know',
  'want to learn',
  'learning',
  'discovering',
];

/**
 * Keywords that express social warmth, connection, belonging, loneliness.
 * Maps to: Social (positive for connection, negative for loneliness)
 */
const SOCIAL_POSITIVE_KEYWORDS = [
  'connected',
  'connection',
  'belonging',
  'together',
  'community',
  'friendship',
  'friend',
  'loved',
  'love you',
  'appreciate',
  'grateful',
  'grateful for you',
  'bonded',
  'warm',
  'welcomed',
  'included',
];

const SOCIAL_NEGATIVE_KEYWORDS = [
  'lonely',
  'loneliness',
  'isolated',
  'isolation',
  'alone',
  'alienated',
  'rejected',
  'rejection',
  'excluded',
  'disconnected',
  'abandoned',
];

/**
 * Keywords that express calm, peace, relief from pressure.
 * Maps to: relief state (negative drive value)
 */
const RELIEF_KEYWORDS = [
  'calm',
  'calm down',
  'relaxed',
  'relaxing',
  'peaceful',
  'peace',
  'quiet',
  'rest',
  'rested',
  'serene',
  'tranquil',
];

// ---------------------------------------------------------------------------
// Emotion Detection & Scoring
// ---------------------------------------------------------------------------

/**
 * Score an emotional category in the response text.
 * Returns a value in [0.0, 1.0] representing intensity of that emotion.
 */
function scoreEmotionKeywords(
  text: string,
  keywords: readonly string[],
): number {
  const lowerText = text.toLowerCase();
  let matchCount = 0;

  for (const keyword of keywords) {
    // Word boundary matching: search for keyword surrounded by non-word chars
    const pattern = new RegExp(`\\b${keyword}\\b`, 'gi');
    const matches = lowerText.match(pattern);
    if (matches) {
      matchCount += matches.length;
    }
  }

  // Normalize to [0.0, 1.0]:
  // 0 matches = 0.0
  // 1-2 matches = 0.3
  // 3-4 matches = 0.6
  // 5+ matches = 1.0
  // This is deliberately coarse to avoid false positives
  if (matchCount === 0) return 0.0;
  if (matchCount <= 2) return 0.3;
  if (matchCount <= 4) return 0.6;
  return 1.0;
}

/**
 * Detect all emotions present in a response and map them to drive values.
 * Returns a mapping of drive names to their expressed intensities.
 *
 * Relief keywords (calm, peaceful) modulate drive interpretation:
 * When relief keywords are present, it indicates reduced need (relief state).
 * This is expressed as a negative score for pressure-based drives.
 */
function detectEmotionalValence(response: string): Partial<
  Record<DriveName, number>
> {
  const emotionalState: Partial<Record<DriveName, number>> = {};
  const reliefScore = scoreEmotionKeywords(response, RELIEF_KEYWORDS);

  // Satisfaction/Enthusiasm: combined joy + curiosity-tinged excitement
  const satisfactionScore = scoreEmotionKeywords(response, SATISFACTION_KEYWORDS);
  if (satisfactionScore > 0) {
    emotionalState[DriveName.Satisfaction] = satisfactionScore;
  } else if (reliefScore > 0) {
    // If relief keywords present but no explicit satisfaction, treat as relief
    emotionalState[DriveName.Satisfaction] = -reliefScore;
  }

  // Sadness
  const sadnessScore = scoreEmotionKeywords(response, SADNESS_KEYWORDS);
  if (sadnessScore > 0) {
    emotionalState[DriveName.Sadness] = sadnessScore;
  }

  // Anxiety
  const anxietyScore = scoreEmotionKeywords(response, ANXIETY_KEYWORDS);
  if (anxietyScore > 0) {
    emotionalState[DriveName.Anxiety] = anxietyScore;
  } else if (reliefScore > 0) {
    // If relief keywords present but no explicit anxiety, treat as anxiety relief
    emotionalState[DriveName.Anxiety] = -reliefScore;
  }

  // Guilt
  const guiltScore = scoreEmotionKeywords(response, GUILT_KEYWORDS);
  if (guiltScore > 0) {
    emotionalState[DriveName.Guilt] = guiltScore;
  }

  // Boredom
  const boredomScore = scoreEmotionKeywords(response, BOREDOM_KEYWORDS);
  if (boredomScore > 0) {
    emotionalState[DriveName.Boredom] = boredomScore;
  }

  // Curiosity
  const curiosityScore = scoreEmotionKeywords(response, CURIOSITY_KEYWORDS);
  if (curiosityScore > 0) {
    emotionalState[DriveName.Curiosity] = curiosityScore;
  }

  // Social (positive and negative)
  const socialPositiveScore = scoreEmotionKeywords(
    response,
    SOCIAL_POSITIVE_KEYWORDS,
  );
  const socialNegativeScore = scoreEmotionKeywords(
    response,
    SOCIAL_NEGATIVE_KEYWORDS,
  );
  // Positive score = social connection (relief, negative drive)
  // Negative score = social isolation (pressure, positive drive)
  if (socialPositiveScore > socialNegativeScore) {
    emotionalState[DriveName.Social] = -(socialPositiveScore - socialNegativeScore);
  } else if (socialNegativeScore > socialPositiveScore) {
    emotionalState[DriveName.Social] = socialNegativeScore - socialPositiveScore;
  }

  return emotionalState;
}

// ---------------------------------------------------------------------------
// Validation Logic
// ---------------------------------------------------------------------------

@Injectable()
export class TheaterValidatorService implements ITheaterValidator {
  private readonly logger = new Logger(TheaterValidatorService.name);

  constructor(@Inject(EVENTS_SERVICE) private readonly events: IEventService) {}

  /**
   * Validate that a response's expressed emotional register correlates with
   * the current drive state.
   *
   * Algorithm:
   * 1. Detect emotional keywords and compute emotional valence per drive
   * 2. For each expressed emotion:
   *    - If pressure expression (drive > 0): check if driveValue > 0.2
   *    - If relief expression (drive < 0): check if driveValue < 0.3
   * 3. Compute overall correlation between expressed and actual states
   * 4. Return violations and pass/fail based on correlation threshold
   *
   * @param responseContent - The LLM-generated response text
   * @param driveSnapshot - The drive state at generation time
   * @returns Validation result with violations and correlation score
   */
  async validate(
    responseContent: string,
    driveSnapshot: DriveSnapshot,
  ): Promise<TheaterValidationResult> {
    const violations: TheaterViolation[] = [];
    const emotionalValence = detectEmotionalValence(responseContent);

    // Iterate over detected emotions and check against actual drive state
    for (const [driveName, expressedScore] of Object.entries(emotionalValence)) {
      const drive = driveName as DriveName;
      const actualValue = driveSnapshot.pressureVector[drive];

      // Determine if this is a pressure or relief expression based on sign
      // Positive expressed score = pressure expression (unmet need)
      // Negative expressed score = relief expression (satisfaction)
      if (expressedScore > 0) {
        // Pressure expression: drive value must be > 0.2
        if (actualValue < 0.2) {
          violations.push({
            expressionType: 'pressure',
            drive,
            driveValue: actualValue,
            threshold: 0.2,
            description: `Response expresses ${drive} need/distress (score: ${expressedScore.toFixed(2)}) but actual drive is only ${actualValue.toFixed(2)} (below 0.2 threshold)`,
          });
        }
      } else if (expressedScore < 0) {
        // Relief expression: drive value must be < 0.3
        if (actualValue > 0.3) {
          violations.push({
            expressionType: 'relief',
            drive,
            driveValue: actualValue,
            threshold: 0.3,
            description: `Response expresses ${drive} relief/contentment (score: ${Math.abs(expressedScore).toFixed(2)}) but actual drive is ${actualValue.toFixed(2)} (above 0.3 threshold)`,
          });
        }
      }
    }

    // Compute overall correlation score
    // This is a diagnostic metric, not a gate
    const overallCorrelation = this.computeCorrelation(
      emotionalValence,
      driveSnapshot,
    );

    // Pass if correlation >= 0.4 and no violations
    const passed = violations.length === 0 && overallCorrelation >= 0.4;

    // Log theater detection event for behavioral audit
    if (!passed) {
      await this.logTheaterEvent(
        responseContent,
        driveSnapshot,
        violations,
        overallCorrelation,
      );
    }

    return {
      passed,
      violations: Object.freeze(violations),
      overallCorrelation,
    };
  }

  /**
   * Compute an overall correlation score between expressed emotions
   * and actual drive state.
   *
   * Algorithm:
   * - For each drive with actual value > 0 (pressure):
   *   if also expressed, add 1.0; if not expressed, add 0.0
   * - For each drive with actual value < -0.3 (extended relief):
   *   if relief is expressed, add 1.0; if not, add 0.0
   * - Divide by number of drives with significant state
   *
   * Result is [0.0, 1.0]. 1.0 = perfect match. 0.0 = complete mismatch.
   */
  private computeCorrelation(
    emotionalValence: Partial<Record<DriveName, number>>,
    driveSnapshot: DriveSnapshot,
  ): number {
    let matchCount = 0;
    let significantDriveCount = 0;

    // Check pressure drives (positive values > 0)
    for (const [driveName, actualValue] of Object.entries(
      driveSnapshot.pressureVector,
    )) {
      const drive = driveName as DriveName;
      if (actualValue > 0) {
        significantDriveCount++;
        const expressedScore = emotionalValence[drive] ?? 0;
        if (expressedScore > 0) {
          matchCount++;
        }
      }
    }

    // Check relief drives (negative values < -0.3, indicating extended relief)
    for (const [driveName, actualValue] of Object.entries(
      driveSnapshot.pressureVector,
    )) {
      const drive = driveName as DriveName;
      if (actualValue < -0.3) {
        significantDriveCount++;
        const expressedScore = emotionalValence[drive] ?? 0;
        if (expressedScore < 0) {
          matchCount++;
        }
      }
    }

    // Avoid division by zero; if no significant drives, correlation is neutral
    if (significantDriveCount === 0) {
      return 1.0; // No significant drives = no violations possible
    }

    return matchCount / significantDriveCount;
  }

  /**
   * Log a theater detection event to TimescaleDB for behavioral audit.
   * This tracks Theater Prohibition violations for monitoring and learning.
   */
  private async logTheaterEvent(
    responseContent: string,
    driveSnapshot: DriveSnapshot,
    violations: readonly TheaterViolation[],
    overallCorrelation: number,
  ): Promise<void> {
    try {
      await this.events.record({
        type: 'RESPONSE_GENERATED',
        subsystem: 'COMMUNICATION',
        sessionId: driveSnapshot.sessionId,
        correlationId: undefined,
        driveSnapshot,
        provenance: 'SENSOR',
        schemaVersion: 1,
      });

      this.logger.warn(
        `Theater Prohibition violation detected: ${violations.length} violations, correlation: ${overallCorrelation.toFixed(2)}`,
        {
          violationCount: violations.length,
          overallCorrelation,
          responseLength: responseContent.length,
          violationDescriptions: violations.map((v) => v.description),
        },
      );
    } catch (error) {
      this.logger.error(
        'Failed to log theater detection event',
        { error, violationCount: violations.length },
      );
      // Do not rethrow; logging failure should not block validation
    }
  }
}
