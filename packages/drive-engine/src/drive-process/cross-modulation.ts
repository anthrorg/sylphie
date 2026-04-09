/**
 * Drive-to-drive cross-modulation effects.
 *
 * CANON §A.15: Inter-drive dynamics that produce behavioral complexity
 * from simple per-drive rules.
 *
 * Applied after individual drive updates but before clamping.
 * These effects model how emotional states interact: high anxiety suppresses
 * curiosity, satisfaction reduces boredom, etc.
 *
 * Rules are defined as a typed CrossModulationRule[] array and evaluated in
 * priority order on each tick. This replaces the previous procedural
 * implementation with a declarative, testable, and extensible structure.
 */

import { DriveName, verboseFor } from '@sylphie/shared';

const vlog = verboseFor('DriveEngine');

// ---------------------------------------------------------------------------
// CrossModulationRule type
// ---------------------------------------------------------------------------

/**
 * Effect mode for a cross-modulation rule.
 *
 * - 'multiplicative': target *= (1 - coefficient * source)
 *   Used for suppression effects (satisfaction reduces boredom, guilt reduces
 *   satisfaction). The coefficient controls the per-tick decay rate.
 *
 * - 'additive': target += coefficient * source
 *   Used for direct amplification (anxiety increases integrity). The full
 *   source value is used as the multiplier.
 *
 * - 'additive_gap': target += coefficient * (source - threshold)
 *   Used for gap-proportional amplification (systemHealth amplifies anxiety,
 *   boredom amplifies curiosity). Only the excess above threshold contributes.
 */
export type CrossModulationMode = 'multiplicative' | 'additive' | 'additive_gap';

/**
 * A single cross-modulation rule describing how one drive influences another.
 *
 * Rules are evaluated in array order (priority). Earlier rules may modify
 * drive values that later rules read — this produces cascading effects
 * (e.g., satisfaction suppresses boredom, then boredom amplifies curiosity).
 */
export interface CrossModulationRule {
  /** Human-readable identifier, e.g., 'satisfaction-suppresses-boredom'. */
  readonly id: string;

  /** Drive that triggers the rule (read but not modified by this rule). */
  readonly source: DriveName;

  /** Drive that is modified when the rule fires. */
  readonly target: DriveName;

  /** Source drive must exceed this value for the rule to fire. */
  readonly threshold: number;

  /** How the effect is applied to the target drive. */
  readonly mode: CrossModulationMode;

  /** Strength of the effect. Interpretation depends on mode. */
  readonly coefficient: number;

  /** Human-readable explanation of the rule's behavioral purpose. */
  readonly description: string;
}

/**
 * Result of evaluating a single rule on a tick, used for logging/metrics.
 */
export interface CrossModulationEffect {
  /** Rule ID that produced this effect. */
  readonly ruleId: string;
  /** Whether the rule's threshold condition was met. */
  readonly fired: boolean;
  /** Source drive value at evaluation time. */
  readonly sourceValue: number;
  /** Target drive value before the rule was applied. */
  readonly targetBefore: number;
  /** Target drive value after the rule was applied. */
  readonly targetAfter: number;
}

// ---------------------------------------------------------------------------
// Rule registry — the 5 active rules (ordered by evaluation priority)
// ---------------------------------------------------------------------------

/**
 * Active cross-modulation rules.
 *
 * Evaluation order matters: rules are applied sequentially, so rule N may
 * see values already modified by rules 0..N-1. This models cascading effects
 * (e.g., satisfaction suppresses boredom in rule 1, then boredom amplifies
 * curiosity in rule 4 using the already-suppressed boredom value).
 *
 * Note: Rule 1 (Anxiety->Curiosity suppression) was removed — it was
 * semantically wrong. Boredom->Curiosity amplification (rule 4) is the
 * correct driver for curiosity dynamics.
 */
export const CROSS_MODULATION_RULES: readonly CrossModulationRule[] = [
  // Rule 1 (priority 0): High satisfaction reduces boredom
  {
    id: 'satisfaction-suppresses-boredom',
    source: DriveName.Satisfaction,
    target: DriveName.Boredom,
    threshold: 0.6,
    mode: 'multiplicative',
    coefficient: 0.03,
    description:
      'High satisfaction reduces boredom. At satisfaction=1.0: boredom *= 0.97/tick (~37% reduction over 60s).',
  },

  // Rule 2 (priority 1): High anxiety increases integrity pressure
  {
    id: 'anxiety-amplifies-integrity',
    source: DriveName.Anxiety,
    target: DriveName.Integrity,
    threshold: 0.7,
    mode: 'additive',
    coefficient: 0.0012,
    description:
      'High anxiety (>0.7) increases integrity pressure. At anxiety=1.0: +0.0012/s (~2x base integrity rate).',
  },

  // Rule 3 (priority 2): High systemHealth pressure amplifies anxiety
  {
    id: 'system-health-amplifies-anxiety',
    source: DriveName.SystemHealth,
    target: DriveName.Anxiety,
    threshold: 0.7,
    mode: 'additive_gap',
    coefficient: 0.003,
    description:
      'High systemHealth pressure (>0.7) amplifies anxiety proportional to excess. At systemHealth=1.0 (gap=0.3): +0.0009/s (~3x base anxiety rate).',
  },

  // Rule 4 (priority 3): High boredom increases curiosity
  {
    id: 'boredom-amplifies-curiosity',
    source: DriveName.Boredom,
    target: DriveName.Curiosity,
    threshold: 0.6,
    mode: 'additive_gap',
    coefficient: 0.003,
    description:
      'High boredom (>0.6) increases curiosity proportional to excess. At boredom=1.0 (gap=0.4): +0.0012/s (doubles curiosity buildup).',
  },

  // Rule 5 (priority 4): High guilt reduces satisfaction
  {
    id: 'guilt-suppresses-satisfaction',
    source: DriveName.Guilt,
    target: DriveName.Satisfaction,
    threshold: 0.4,
    mode: 'multiplicative',
    coefficient: 0.03,
    description:
      'High guilt (>0.4) reduces satisfaction. At guilt=1.0: satisfaction *= 0.97/tick (~37% reduction over 60s).',
  },
] as const;

// ---------------------------------------------------------------------------
// Rule evaluation engine
// ---------------------------------------------------------------------------

/**
 * Apply a single cross-modulation rule to the drive state.
 *
 * @param rule - The rule to evaluate
 * @param state - Mutable drive state (modified in place if rule fires)
 * @returns Effect record for logging/metrics
 */
export function applyRule(
  rule: CrossModulationRule,
  state: Record<DriveName, number>,
): CrossModulationEffect {
  const sourceValue = state[rule.source];
  const targetBefore = state[rule.target];

  // Check threshold condition
  if (sourceValue <= rule.threshold) {
    return {
      ruleId: rule.id,
      fired: false,
      sourceValue,
      targetBefore,
      targetAfter: targetBefore,
    };
  }

  // Apply effect based on mode
  switch (rule.mode) {
    case 'multiplicative':
      // target *= (1 - coefficient * source)
      state[rule.target] *= 1 - rule.coefficient * sourceValue;
      break;

    case 'additive':
      // target += coefficient * source
      state[rule.target] += rule.coefficient * sourceValue;
      break;

    case 'additive_gap':
      // target += coefficient * (source - threshold)
      state[rule.target] += rule.coefficient * (sourceValue - rule.threshold);
      break;
  }

  return {
    ruleId: rule.id,
    fired: true,
    sourceValue,
    targetBefore,
    targetAfter: state[rule.target],
  };
}

/**
 * Apply all cross-modulation rules to the drive state.
 *
 * Rules are evaluated in array order (priority). Earlier rules may modify
 * values that later rules read. The state is modified in place.
 * Clamping is NOT applied here — it happens after all cross-modulation
 * is complete, in the caller.
 *
 * @param state - Mutable drive state to modify in-place
 * @param rules - Rule array to evaluate (defaults to CROSS_MODULATION_RULES)
 */
export function applyCrossModulation(
  state: Record<DriveName, number>,
  rules: readonly CrossModulationRule[] = CROSS_MODULATION_RULES,
): void {
  const effects: string[] = [];

  for (const rule of rules) {
    const effect = applyRule(rule, state);
    if (effect.fired) {
      effects.push(
        `${rule.id}: ${rule.source}(${effect.sourceValue.toFixed(3)})→${rule.target} ${effect.targetBefore.toFixed(3)}→${effect.targetAfter.toFixed(3)}`,
      );
    }
  }

  if (effects.length > 0) {
    vlog('cross-modulation effects', { effects });
  }
}
