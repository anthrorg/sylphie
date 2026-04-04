/**
 * Rule pattern matching engine.
 *
 * CANON §Subsystem 4 (Drive Engine), step 3: Pattern matching for rule triggers.
 *
 * Rules are stored as simple trigger patterns like "action_success AND anxiety > 0.7".
 * This module parses and evaluates those patterns against incoming events and
 * current drive state to determine which rules should fire.
 *
 * Matching must be deterministic and fast (<5ms for 100 rules).
 */

import { DriveName, PressureVector } from '@sylphie/shared';

/**
 * A parsed rule trigger pattern, ready for evaluation.
 */
export interface ParsedTrigger {
  conditions: Condition[];
  operator: 'AND' | 'OR';
}

/**
 * A single condition within a trigger pattern.
 *
 * Event conditions match on incoming event types:
 *   - 'action_success', 'action_failure', etc.
 *
 * Drive conditions match on drive state:
 *   - 'anxiety > 0.7', 'satisfaction < 0.2', 'guilt = 0', etc.
 */
export interface Condition {
  type: 'event' | 'drive';
  eventType?: string; // For event conditions: 'action_success', etc.
  driveName?: DriveName;
  operator?: string; // '>', '<', '=', '>=', '<=', '!='
  value?: number;
}

/**
 * Event context for rule matching.
 *
 * Contains the incoming event type and the current drive state snapshot.
 * This is everything the matcher needs to evaluate rules.
 */
export interface RuleMatchContext {
  eventType: string;
  driveState: PressureVector;
}

/**
 * Parse a trigger pattern string into a structured ParsedTrigger.
 *
 * Examples:
 *   "action_success" → { conditions: [{ type: 'event', eventType: 'action_success' }], operator: 'AND' }
 *   "action_success AND anxiety > 0.7" → { conditions: [..., ...], operator: 'AND' }
 *   "prediction_hit OR prediction_miss" → { conditions: [..., ...], operator: 'OR' }
 *
 * @param pattern - The trigger pattern string from the database
 * @returns Parsed trigger, or null if the pattern is invalid
 */
export function parseTriggerPattern(pattern: string): ParsedTrigger | null {
  try {
    const trimmed = pattern.trim();

    // Determine the main operator (AND or OR)
    const hasOr = trimmed.includes(' OR ');
    const hasAnd = trimmed.includes(' AND ');

    let operator: 'AND' | 'OR' = 'AND';
    let parts: string[] = [];

    if (hasOr && !hasAnd) {
      operator = 'OR';
      parts = trimmed.split(' OR ').map((p) => p.trim());
    } else if (hasAnd && !hasOr) {
      operator = 'AND';
      parts = trimmed.split(' AND ').map((p) => p.trim());
    } else if (!hasOr && !hasAnd) {
      // Single condition
      parts = [trimmed];
      operator = 'AND'; // Default
    } else {
      // Mixed operators not supported
      return null;
    }

    const conditions: Condition[] = [];

    for (const part of parts) {
      const cond = parseCondition(part);
      if (!cond) {
        return null; // Invalid condition
      }
      conditions.push(cond);
    }

    return { conditions, operator };
  } catch (_err) {
    return null; // Parsing error
  }
}

/**
 * Parse a single condition string.
 *
 * Examples:
 *   "action_success" → { type: 'event', eventType: 'action_success' }
 *   "anxiety > 0.7" → { type: 'drive', driveName: 'anxiety', operator: '>', value: 0.7 }
 *
 * @param conditionStr - A single condition string
 * @returns Parsed condition, or null if invalid
 */
function parseCondition(conditionStr: string): Condition | null {
  const trimmed = conditionStr.trim();

  // Check if it's a drive comparison (contains >, <, =, >=, <=, !=)
  const drivePattern = /^(\w+)\s*(>|<|=|>=|<=|!=)\s*([-+]?[\d.]+)$/;
  const driveMatch = trimmed.match(drivePattern);

  if (driveMatch) {
    const [, driveName, operator, value] = driveMatch;
    const drive = driveName as DriveName;

    // Validate that this is a real drive name
    if (!Object.values(DriveName).includes(drive)) {
      return null;
    }

    return {
      type: 'drive',
      driveName: drive,
      operator,
      value: parseFloat(value),
    };
  }

  // Otherwise, treat as an event type
  // Event types are simple identifiers like "action_success", "prediction_hit"
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
    return {
      type: 'event',
      eventType: trimmed,
    };
  }

  return null; // Invalid condition
}

/**
 * Evaluate a parsed trigger against a rule match context.
 *
 * Returns true if the trigger matches, false otherwise.
 *
 * @param trigger - Parsed trigger pattern
 * @param context - Event and drive state context
 * @returns Whether the trigger matched
 */
export function evaluateTrigger(
  trigger: ParsedTrigger,
  context: RuleMatchContext,
): boolean {
  const results: boolean[] = [];

  for (const condition of trigger.conditions) {
    const matches = evaluateCondition(condition, context);
    results.push(matches);
  }

  // Combine results with the operator
  if (trigger.operator === 'AND') {
    return results.every((r) => r);
  } else {
    return results.some((r) => r);
  }
}

/**
 * Evaluate a single condition against the rule match context.
 *
 * @param condition - The condition to evaluate
 * @param context - Event and drive state context
 * @returns Whether the condition matched
 */
function evaluateCondition(
  condition: Condition,
  context: RuleMatchContext,
): boolean {
  if (condition.type === 'event') {
    // Event condition: check if the incoming event type matches
    return condition.eventType === context.eventType;
  } else {
    // Drive condition: check if the drive state satisfies the comparison
    if (!condition.driveName || !condition.operator || condition.value === undefined) {
      return false;
    }

    const driveValue = context.driveState[condition.driveName];
    const threshold = condition.value;

    switch (condition.operator) {
      case '>':
        return driveValue > threshold;
      case '<':
        return driveValue < threshold;
      case '=':
        return Math.abs(driveValue - threshold) < 0.0001; // Floating-point equality
      case '>=':
        return driveValue >= threshold;
      case '<=':
        return driveValue <= threshold;
      case '!=':
        return Math.abs(driveValue - threshold) >= 0.0001;
      default:
        return false;
    }
  }
}

/**
 * Quick cache key generator for rule matching results.
 *
 * The cache key combines the event type with a hash of relevant drive state
 * values. This reduces cache misses while keeping key size manageable.
 *
 * @param eventType - The incoming event type
 * @param driveState - The current drive state
 * @returns A string cache key
 */
export function generateCacheKey(eventType: string, driveState: PressureVector): string {
  // Hash the drive state to a short string
  // Use only drives that commonly appear in rules to keep the key small
  const relevantDrives = [
    DriveName.Anxiety,
    DriveName.Satisfaction,
    DriveName.Guilt,
    DriveName.CognitiveAwareness,
  ];

  let stateHash = '';
  for (const drive of relevantDrives) {
    const val = Math.round(driveState[drive] * 100); // 2 decimal precision
    stateHash += `${drive}:${val};`;
  }

  return `${eventType}|${stateHash}`;
}
