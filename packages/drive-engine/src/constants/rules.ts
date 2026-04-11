/**
 * Rule Engine constants and default affects.
 *
 * CANON §Subsystem 4 (Drive Engine), step 3: Rule loading, matching, and application.
 *
 * Default affects provide baseline behavioral responses when no custom rules match
 * an incoming event. These are foundational contingencies that ensure the drive
 * system reacts appropriately to outcomes and metrics without requiring explicit
 * rule definition.
 *
 * TUNING TARGET: ~30 conversation responses should move primary drives from
 * 1.0 to -10.0 (full relief). That's ~0.367 relief per response for primary
 * drives (social, boredom, curiosity), ~0.18 for secondary drives.
 */

import { DriveName } from '@sylphie/shared';
import type { ActionOutcomePayload } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Rule Engine Configuration
// ---------------------------------------------------------------------------

/**
 * How often the rule engine reloads active rules from PostgreSQL, in milliseconds.
 *
 * Rules can be approved by the guardian through the dashboard. A periodic reload
 * ensures the running engine picks up new rules without requiring a restart.
 *
 * ACCEPTANCE CRITERIA: Rules should be picked up within 60 seconds of approval.
 */
export const RULE_RELOAD_INTERVAL_MS = 60000;

/**
 * Minimum confidence threshold for a rule to be applied.
 *
 * Rules with confidence < this threshold are ignored, even if they match.
 * This prevents low-confidence experimental rules from affecting behavior.
 *
 * Confidence values typically range [0.3, 1.0]:
 *   0.3 = newly proposed rule, minimal evidence
 *   0.60 = guardian-confirmed rule
 *   0.80+ = highly validated through Type 1 graduation
 */
export const RULE_CONFIDENCE_THRESHOLD = 0.3;

/**
 * LRU cache maximum size for rule matching results.
 *
 * Caching reduces recomputation when the same event patterns repeat.
 * Cache key is a hash of the event type + relevant drive state.
 * Cache is invalidated on every rule reload.
 */
export const RULE_CACHE_MAX_SIZE = 500;

// ---------------------------------------------------------------------------
// Default Affects by Action Category
// ---------------------------------------------------------------------------

/**
 * Primary conversation relief per response: ~0.367.
 * 30 responses × 0.367 = 11.01 → moves from 1.0 to -10.0.
 */
const PRIMARY_RELIEF = -0.367;

/**
 * Secondary relief per response: ~0.18 (half of primary).
 */
const SECONDARY_RELIEF = -0.183;

/**
 * Default drive effects by actionType (the procedure category).
 *
 * These fire when no PostgreSQL rule matches the incoming actionType.
 * They represent the system's innate (bootstrap) response to different
 * kinds of actions. Over time, guardian-approved rules will replace them.
 *
 * Negative values = relief (drive pressure decreases).
 * Positive values = pressure (drive pressure increases).
 */
export const ACTION_TYPE_DEFAULTS: Record<string, Partial<Record<DriveName, number>>> = {
  // -- Conversational actions (strong relief) --------------------------------

  ConversationalResponse: {
    [DriveName.Social]: PRIMARY_RELIEF,
    [DriveName.Boredom]: PRIMARY_RELIEF,
    [DriveName.Curiosity]: SECONDARY_RELIEF,
    [DriveName.Satisfaction]: 0.012,
    [DriveName.Anxiety]: SECONDARY_RELIEF,
    [DriveName.CognitiveAwareness]: SECONDARY_RELIEF,
  },

  GuardianEngagement: {
    [DriveName.Social]: PRIMARY_RELIEF,
    [DriveName.Boredom]: PRIMARY_RELIEF,
    [DriveName.Curiosity]: SECONDARY_RELIEF,
    [DriveName.Satisfaction]: 0.012,
    [DriveName.Anxiety]: SECONDARY_RELIEF,
  },

  SocialComment: {
    [DriveName.Social]: PRIMARY_RELIEF,
    [DriveName.Boredom]: -0.25,
    [DriveName.Satisfaction]: 0.012,
  },

  LearnedResponse: {
    [DriveName.Social]: PRIMARY_RELIEF,
    [DriveName.Boredom]: PRIMARY_RELIEF,
    [DriveName.Curiosity]: SECONDARY_RELIEF,
    [DriveName.Satisfaction]: 0.012,
    [DriveName.Anxiety]: SECONDARY_RELIEF,
  },

  // -- Knowledge/inquiry actions (curiosity-focused relief) ------------------

  KnowledgeQuery: {
    [DriveName.Curiosity]: PRIMARY_RELIEF,
    [DriveName.CognitiveAwareness]: -0.25,
    [DriveName.Boredom]: SECONDARY_RELIEF,
  },

  SocialInquiry: {
    [DriveName.Social]: PRIMARY_RELIEF,
    [DriveName.Curiosity]: -0.25,
    [DriveName.Boredom]: SECONDARY_RELIEF,
  },

  VisualInquiry: {
    [DriveName.Curiosity]: PRIMARY_RELIEF,
    [DriveName.Focus]: -0.25,
    [DriveName.Boredom]: SECONDARY_RELIEF,
  },

  // -- Self-correction -------------------------------------------------------

  SelfCorrection: {
    [DriveName.Integrity]: -0.15,
    [DriveName.MoralValence]: SECONDARY_RELIEF,
  },

  // -- Guardian teaching (pressure, not relief — drives learning need) -------

  GuardianTeaching: {
    [DriveName.CognitiveAwareness]: 0.15,
  },

  // -- Sensory signals (metadata-scaled, small per-tick) ---------------------
  // These use metadata.count to scale. The base values here are per-unit.
  // The drive engine multiplies by the count from metadata.

  UndiscoveredObjectPressure: {
    [DriveName.Curiosity]: 0.01,    // per undiscovered object
    [DriveName.Focus]: 0.005,
  },

  UnknownPersonPressure: {
    [DriveName.Social]: 0.015,      // per unknown person
    [DriveName.Curiosity]: 0.005,
  },

  SensoryPrediction: {
    [DriveName.Curiosity]: 0.01,    // scaled by prediction error magnitude
  },

  ScenePrediction: {
    [DriveName.Curiosity]: 0.02,    // scaled by scene surprise magnitude
    [DriveName.Anxiety]: 0.01,
  },
};

/**
 * Sensory action types that scale their effects by metadata counts/magnitudes.
 * These are NOT flat defaults — the drive engine multiplies by the signal value.
 */
export const METADATA_SCALED_ACTION_TYPES = new Set([
  'UndiscoveredObjectPressure',
  'UnknownPersonPressure',
  'SensoryPrediction',
  'ScenePrediction',
]);

// ---------------------------------------------------------------------------
// Legacy Default Affects (by outcome type)
// ---------------------------------------------------------------------------

/**
 * Outcome-level defaults (positive/negative, guardian feedback).
 * These are layered ON TOP of the action-type defaults.
 *
 * For example, a ConversationalResponse with guardian_confirmation gets:
 *   ACTION_TYPE_DEFAULTS['ConversationalResponse'] (base relief)
 *   + OUTCOME_DEFAULTS['guardian_confirmation'] (bonus from guardian approval)
 */
export const OUTCOME_DEFAULTS: Record<string, Partial<Record<DriveName, number>>> = {
  guardian_confirmation: {
    [DriveName.Satisfaction]: 0.15,
    [DriveName.MoralValence]: -0.10,
    [DriveName.Anxiety]: -0.05,
  },

  guardian_correction: {
    [DriveName.Guilt]: 0.15,
    [DriveName.Satisfaction]: -0.10,
  },
};

/**
 * Compute the default affect for an action outcome signal.
 *
 * Combines:
 * 1. Action-type defaults (what kind of action was it?)
 * 2. Outcome-type bonuses (was it guardian confirmed/corrected?)
 * 3. Metadata scaling for sensory signals
 *
 * @param payload - The ACTION_OUTCOME signal (no driveEffects field)
 * @returns Computed drive effects map
 */
export function computeDefaultAffect(
  payload: ActionOutcomePayload,
): Partial<Record<DriveName, number>> {
  const effects: Partial<Record<DriveName, number>> = {};

  // 1. Action-type base effects
  const actionDefaults = ACTION_TYPE_DEFAULTS[payload.actionType];
  if (actionDefaults) {
    for (const [drive, delta] of Object.entries(actionDefaults)) {
      const d = drive as DriveName;
      let scaledDelta = delta;

      // Scale sensory signals by metadata
      if (METADATA_SCALED_ACTION_TYPES.has(payload.actionType) && payload.metadata) {
        const meta = payload.metadata;
        if (payload.actionType === 'UndiscoveredObjectPressure' && meta.undiscoveredObjectCount != null) {
          scaledDelta = delta * meta.undiscoveredObjectCount;
        } else if (payload.actionType === 'UnknownPersonPressure' && meta.unknownPersonCount != null) {
          scaledDelta = delta * meta.unknownPersonCount;
        } else if (payload.actionType === 'SensoryPrediction' && meta.sensoryPredictionError != null) {
          scaledDelta = delta * meta.sensoryPredictionError;
        } else if (payload.actionType === 'ScenePrediction' && meta.sceneSurprise != null) {
          scaledDelta = delta * meta.sceneSurprise;
        }
      }

      effects[d] = (effects[d] ?? 0) + scaledDelta;
    }
  }

  // 2. Outcome-type bonus (guardian feedback)
  const outcomeDefaults = OUTCOME_DEFAULTS[payload.feedbackSource];
  if (outcomeDefaults) {
    for (const [drive, delta] of Object.entries(outcomeDefaults)) {
      const d = drive as DriveName;
      effects[d] = (effects[d] ?? 0) + delta;
    }
  }

  return effects;
}
