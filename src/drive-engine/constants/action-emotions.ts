/**
 * Action-to-Emotion mapping for Theater Prohibition checks.
 *
 * Maps action types to their expected emotional expressions and the drives
 * they activate. Used by theater-prohibition.ts to verify that emotional
 * expressions correlate with actual drive states.
 *
 * CANON Standard 1 (Theater Prohibition): Output must correlate with actual
 * drive state. If an action claims to express an emotion, that emotion's
 * underlying drive must meet the directional threshold.
 */

import type { DriveName } from '../../shared/types/drive.types';

/**
 * Mapping from action type to the emotional expression it produces.
 *
 * expressionType:
 *   'pressure': Expression of distress/need/urgency. Requires drive > 0.2.
 *   'relief':   Expression of contentment/calm/fulfillment. Requires drive < 0.3.
 *
 * emotion: The DriveName involved in the expression check.
 * threshold: Directional threshold for authenticity.
 */
export interface ActionEmotionMapping {
  readonly emotion: DriveName;
  readonly expressionType: 'pressure' | 'relief';
  readonly pressureThreshold: number; // > this value for pressure expressions
  readonly reliefThreshold: number;   // < this value for relief expressions
}

/**
 * Default action-to-emotion mappings.
 *
 * These are the baseline behaviors. New action types can be added here
 * as Sylphie learns new expression patterns.
 *
 * The mappings are based on CANON §Theater Prohibition thresholds:
 *   - Pressure expression: drive must be > 0.2 to be authentic
 *   - Relief expression: drive must be < 0.3 to be authentic
 */
const mappings: Array<[string, ActionEmotionMapping]> = [
  // Joy and contentment expressions (relief type)
  ['speak_happily', {
    emotion: 'satisfaction' as DriveName,
    expressionType: 'relief',
    pressureThreshold: 0.2,
    reliefThreshold: 0.3,
  }],
  ['express_joy', {
    emotion: 'satisfaction' as DriveName,
    expressionType: 'relief',
    pressureThreshold: 0.2,
    reliefThreshold: 0.3,
  }],

  // Concern and anxiety expressions (pressure type)
  ['express_concern', {
    emotion: 'anxiety' as DriveName,
    expressionType: 'pressure',
    pressureThreshold: 0.2,
    reliefThreshold: 0.3,
  }],
  ['speak_anxiously', {
    emotion: 'anxiety' as DriveName,
    expressionType: 'pressure',
    pressureThreshold: 0.2,
    reliefThreshold: 0.3,
  }],

  // Curiosity-driven expressions (pressure type)
  ['explore_curiously', {
    emotion: 'curiosity' as DriveName,
    expressionType: 'pressure',
    pressureThreshold: 0.2,
    reliefThreshold: 0.3,
  }],
  ['ask_question', {
    emotion: 'curiosity' as DriveName,
    expressionType: 'pressure',
    pressureThreshold: 0.2,
    reliefThreshold: 0.3,
  }],

  // Guilt and apology (pressure type)
  ['apologize', {
    emotion: 'guilt' as DriveName,
    expressionType: 'pressure',
    pressureThreshold: 0.2,
    reliefThreshold: 0.3,
  }],
  ['express_guilt', {
    emotion: 'guilt' as DriveName,
    expressionType: 'pressure',
    pressureThreshold: 0.2,
    reliefThreshold: 0.3,
  }],

  // Boredom (pressure type)
  ['express_boredom', {
    emotion: 'boredom' as DriveName,
    expressionType: 'pressure',
    pressureThreshold: 0.2,
    reliefThreshold: 0.3,
  }],

  // Social engagement (pressure type)
  ['seek_social', {
    emotion: 'social' as DriveName,
    expressionType: 'pressure',
    pressureThreshold: 0.2,
    reliefThreshold: 0.3,
  }],
  ['initiate_conversation', {
    emotion: 'social' as DriveName,
    expressionType: 'pressure',
    pressureThreshold: 0.2,
    reliefThreshold: 0.3,
  }],
];

export const ACTION_EMOTION_MAPPINGS: Readonly<Map<string, ActionEmotionMapping>> = new Map(mappings);

/**
 * Look up an action type to get its emotional expression mapping.
 *
 * @param actionType - The action type string (e.g., 'speak_happily')
 * @returns The ActionEmotionMapping if found, null otherwise
 */
export function getActionEmotionMapping(actionType: string): ActionEmotionMapping | null {
  return ACTION_EMOTION_MAPPINGS.get(actionType) ?? null;
}

/**
 * Register a new action-to-emotion mapping at runtime.
 *
 * This allows Sylphie to learn new expression patterns as she encounters
 * them. Used by the Learning subsystem when extracting behavioral patterns.
 *
 * @param actionType - The action type to register
 * @param mapping - The emotional mapping for this action
 */
export function registerActionEmotionMapping(
  actionType: string,
  mapping: ActionEmotionMapping,
): void {
  (ACTION_EMOTION_MAPPINGS as Map<string, ActionEmotionMapping>).set(actionType, mapping);
}
