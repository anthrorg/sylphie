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

import type { DriveName } from '@sylphie/shared';

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

/**
 * Build a Map whose mutators are disabled at RUNTIME, then expose it as a
 * `ReadonlyMap`.
 *
 * CANON Standard 6 (No self-modification of evaluation): the action→emotion
 * table is the lookup Theater Prohibition consumes to decide whether an
 * emotional expression is authentic. A runtime mutation API on it (the former
 * `registerActionEmotionMapping`, which cast away `Readonly` and `.set()`) was a
 * back-door for the evaluation criteria to modify themselves. That API is
 * removed. The `Readonly<Map>` type only prevented mutation at COMPILE time — a
 * `as Map` cast defeated it — so we also harden the runtime: `set`/`delete`/
 * `clear` throw, and the object is frozen. Any future attempt to mutate the
 * evaluation table fails loudly instead of silently succeeding.
 *
 * If new action→emotion mappings are ever genuinely needed, the CANON-correct
 * path is the `proposed_drive_rules` review pipeline — NOT runtime mutation here.
 */
function freezeAsReadonlyMap<K, V>(entries: Array<[K, V]>): ReadonlyMap<K, V> {
  const map = new Map<K, V>(entries);
  const blocked = (op: string) => (): never => {
    throw new Error(
      `ACTION_EMOTION_MAPPINGS is immutable (CANON Standard 6): ${op} is prohibited. ` +
        'The action→emotion evaluation table cannot be self-modified at runtime; ' +
        'use the proposed_drive_rules review pipeline instead.',
    );
  };
  // Disable every mutator on this instance. Reads (get/has/keys/values/entries/
  // forEach/size/iteration) remain fully functional.
  Object.defineProperties(map, {
    set: { value: blocked('set'), configurable: false, writable: false },
    delete: { value: blocked('delete'), configurable: false, writable: false },
    clear: { value: blocked('clear'), configurable: false, writable: false },
  });
  Object.freeze(map);
  return map;
}

export const ACTION_EMOTION_MAPPINGS: ReadonlyMap<string, ActionEmotionMapping> =
  freezeAsReadonlyMap(mappings);

/**
 * Look up an action type to get its emotional expression mapping.
 *
 * @param actionType - The action type string (e.g., 'speak_happily')
 * @returns The ActionEmotionMapping if found, null otherwise
 */
export function getActionEmotionMapping(actionType: string): ActionEmotionMapping | null {
  return ACTION_EMOTION_MAPPINGS.get(actionType) ?? null;
}
