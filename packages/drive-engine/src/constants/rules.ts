/**
 * Rule Engine constants and default affects.
 *
 * CANON §Subsystem 4 (Drive Engine), step 3: Rule loading, matching, and application.
 *
 * Default affects provide baseline behavioral responses when no custom rules match
 * an incoming event. These are foundational contingencies that ensure the drive
 * system reacts appropriately to outcomes and metrics without requiring explicit
 * rule definition.
 */

import { DriveName } from '@sylphie/shared';

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
// Default Affects (Fallback Contingencies)
// ---------------------------------------------------------------------------

/**
 * Default behavioral effects when no rules match an incoming event.
 *
 * CANON §Contingency Requirement (Standard 2): Every reinforcement must trace
 * to a specific behavior. These defaults provide a behavioral baseline when
 * custom rules haven't been defined yet. Over time, custom rules will override
 * and refine these defaults.
 *
 * Keys are outcome types (event types) that the Drive Engine receives.
 * Values are partial maps of drive deltas to apply.
 *
 * Event types:
 *   action_success     — An executed action produced the expected positive outcome
 *   action_failure     — An executed action produced a negative outcome
 *   prediction_hit     — A prediction about future state was validated
 *   prediction_miss    — A prediction was incorrect
 *   guardian_confirmation — Guardian explicitly approved a behavior or state
 *   guardian_correction — Guardian explicitly corrected behavior or state
 */
export const DEFAULT_AFFECTS: Record<string, Partial<Record<DriveName, number>>> = {
  // Action succeeded: satisfaction increases, pressure decreases slightly
  action_success: {
    [DriveName.Satisfaction]: 0.1, // Relief from achieving goal
  },

  // Action failed: anxiety and loss, satisfaction decreases
  action_failure: {
    [DriveName.Anxiety]: 0.05, // Increased vigilance
    [DriveName.Satisfaction]: -0.05, // Loss from failure
  },

  // Prediction was correct: cognitive relief
  prediction_hit: {
    [DriveName.CognitiveAwareness]: -0.05, // Relief: world is predictable
  },

  // Prediction was incorrect: increased cognitive pressure
  prediction_miss: {
    [DriveName.CognitiveAwareness]: 0.1, // Pressure: need to revise model
  },

  // Guardian confirmed behavior: strong satisfaction + social boost
  guardian_confirmation: {
    [DriveName.Satisfaction]: 0.15, // Strong positive feedback
    [DriveName.Social]: 0.05, // Connection with guardian
  },

  // Guardian corrected behavior: guilt + loss of satisfaction
  guardian_correction: {
    [DriveName.Guilt]: 0.15, // Negative feedback
    [DriveName.Satisfaction]: -0.1, // Loss from being corrected
  },
};

/**
 * Map of outcome types to their default affect keys.
 * Used to look up the correct default affect for an incoming event.
 */
export const OUTCOME_TYPE_TO_DEFAULT_AFFECT: Record<string, string> = {
  action_success: 'action_success',
  action_failure: 'action_failure',
  prediction_hit: 'prediction_hit',
  prediction_miss: 'prediction_miss',
  guardian_confirmation: 'guardian_confirmation',
  guardian_correction: 'guardian_correction',
};
