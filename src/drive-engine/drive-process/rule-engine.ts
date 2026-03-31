/**
 * Rule engine: PostgreSQL rule lookup, matching, and application.
 *
 * CANON §Subsystem 4 (Drive Engine), step 3: Rule loading, matching, and application.
 *
 * The rule engine is the enforcement mechanism for behavioral contingencies.
 * It runs in the Drive Engine child process with its own PostgreSQL connection
 * (not NestJS DI). Rules are loaded on startup and reloaded every 60 seconds
 * to pick up guardian-approved rules.
 *
 * Sequence:
 * 1. Load active rules from PostgreSQL drive_rules table
 * 2. For each outcome/event, match against all loaded rules
 * 3. If rules match, apply their effects (DSL: "anxiety += 0.1")
 * 4. If no rules match, apply default affects (fallback contingencies)
 * 5. Accumulate all effects and return as drive deltas
 */

import { Pool } from 'pg';
import { DriveName, PressureVector } from '../../shared/types/drive.types';
import {
  RULE_RELOAD_INTERVAL_MS,
  RULE_CONFIDENCE_THRESHOLD,
  RULE_CACHE_MAX_SIZE,
} from '../constants/rules';
import {
  ParsedTrigger,
  parseTriggerPattern,
  evaluateTrigger,
  generateCacheKey,
  RuleMatchContext,
} from './rule-matching';
import { parseEffect, accumulateRuleEffects } from './rule-application';
import { applyDefaultAffect } from './default-affect';
import { RuleMatchCache } from './rule-cache';

/**
 * Active drive rule loaded from the PostgreSQL drive_rules table.
 */
interface LoadedRule {
  id: string;
  triggerPattern: string;
  parsedTrigger: ParsedTrigger | null; // Cached parse result
  effect: string;
  confidence: number;
  createdAt: Date;
}

/**
 * Result of matching and applying rules to an event.
 */
export interface RuleApplicationResult {
  matchedRuleIds: string[];
  driveEffects: Partial<Record<DriveName, number>>;
  usedDefaultAffect: boolean;
}

/**
 * The Rule Engine: Loads rules from PostgreSQL, matches them against events,
 * and applies effects to drive state.
 *
 * Runs in the Drive Engine child process.
 */
export class RuleEngine {
  private pool: Pool | null = null;
  private rules: LoadedRule[] = [];
  private cache: RuleMatchCache;
  private lastReloadAt: number = 0;
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.cache = new RuleMatchCache(RULE_CACHE_MAX_SIZE);
  }

  /**
   * Initialize the rule engine with a PostgreSQL connection.
   *
   * Called once at startup. Creates a connection pool and loads the initial
   * rules from the database. Also schedules periodic rule reloads.
   *
   * @param pool - A pg Pool instance for database access
   * @throws Error if the initial rule load fails
   */
  async initialize(pool: Pool): Promise<void> {
    this.pool = pool;
    await this.reloadRules();
    this.schedulePeriodicReload();
  }

  /**
   * Shut down the rule engine gracefully.
   *
   * Clears the periodic reload timer. The pool is managed by the caller.
   */
  shutdown(): void {
    if (this.reloadTimer) {
      clearInterval(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  /**
   * Match and apply rules to an incoming event.
   *
   * Process:
   * 1. Check cache for cached results
   * 2. If not cached, match all loaded rules against the event
   * 3. Apply matched rule effects
   * 4. If no rules matched, apply default affect
   * 5. Cache the result
   * 6. Return accumulated effects
   *
   * @param eventType - The incoming event type (e.g., 'action_success')
   * @param driveState - The current drive state snapshot
   * @returns Rule application result with matched rules and effects
   */
  matchAndApply(
    eventType: string,
    driveState: PressureVector,
  ): RuleApplicationResult {
    const cacheKey = generateCacheKey(eventType, driveState);

    // Check cache first
    const cachedRuleIds = this.cache.get(cacheKey);
    if (cachedRuleIds !== null) {
      // Use cached result
      const effects = this.applyRulesByIds(cachedRuleIds);
      return {
        matchedRuleIds: cachedRuleIds,
        driveEffects: effects,
        usedDefaultAffect: false,
      };
    }

    // No cache hit; perform matching
    const context: RuleMatchContext = { eventType, driveState };
    const matchedRuleIds: string[] = [];
    const matchedEffects: string[] = [];

    for (const rule of this.rules) {
      // Skip rules with low confidence
      if (rule.confidence < RULE_CONFIDENCE_THRESHOLD) {
        continue;
      }

      // Skip if trigger pattern didn't parse (invalid rule)
      if (!rule.parsedTrigger) {
        continue;
      }

      // Check if this rule matches
      if (evaluateTrigger(rule.parsedTrigger, context)) {
        matchedRuleIds.push(rule.id);
        matchedEffects.push(rule.effect);
      }
    }

    // Cache the matched rule IDs for future lookups
    this.cache.set(cacheKey, matchedRuleIds);

    // Apply matched rule effects
    let driveEffects = accumulateRuleEffects(matchedEffects);

    // If no rules matched, apply default affect
    let usedDefaultAffect = false;
    if (matchedRuleIds.length === 0) {
      driveEffects = applyDefaultAffect(eventType, driveEffects);
      usedDefaultAffect = true;
    }

    return {
      matchedRuleIds,
      driveEffects,
      usedDefaultAffect,
    };
  }

  /**
   * Apply rule effects by rule IDs.
   *
   * Used for cached results: given a set of rule IDs that previously matched,
   * re-apply their effects without re-matching.
   *
   * @param ruleIds - The rule IDs to apply
   * @returns Accumulated drive effects
   */
  private applyRulesByIds(ruleIds: string[]): Partial<Record<DriveName, number>> {
    const effects: string[] = [];

    for (const ruleId of ruleIds) {
      const rule = this.rules.find((r) => r.id === ruleId);
      if (rule) {
        effects.push(rule.effect);
      }
    }

    return accumulateRuleEffects(effects);
  }

  /**
   * Reload all active rules from the PostgreSQL database.
   *
   * Called on startup and periodically (every 60s) to pick up guardian-approved
   * rules. This is an async operation that doesn't interrupt the tick loop.
   *
   * @throws Error if the database query fails
   */
  private async reloadRules(): Promise<void> {
    if (!this.pool) {
      return; // Not initialized yet
    }

    try {
      const result = await this.pool.query(
        `SELECT
          id,
          trigger_pattern AS "triggerPattern",
          effect,
          confidence,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
         FROM drive_rules
         WHERE enabled = true
         ORDER BY created_at DESC`,
      );

      const newRules: LoadedRule[] = [];

      for (const row of result.rows) {
        const parsedTrigger = parseTriggerPattern(row.triggerPattern);

        newRules.push({
          id: row.id,
          triggerPattern: row.triggerPattern,
          parsedTrigger,
          effect: row.effect,
          confidence: row.confidence,
          createdAt: new Date(row.createdAt),
        });
      }

      this.rules = newRules;
      this.lastReloadAt = Date.now();

      // Invalidate cache when rules change
      this.cache.clear();

      // Log reload (to stderr, since this runs in a child process)
      if (typeof process !== 'undefined' && process.stderr) {
        process.stderr.write(
          `[RuleEngine] Reloaded ${newRules.length} active rules at ${new Date().toISOString()}\n`,
        );
      }
    } catch (err) {
      if (typeof process !== 'undefined' && process.stderr) {
        process.stderr.write(
          `[RuleEngine] Failed to reload rules: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  /**
   * Schedule periodic rule reloads from the database.
   *
   * Runs every RULE_RELOAD_INTERVAL_MS (default 60000ms).
   */
  private schedulePeriodicReload(): void {
    this.reloadTimer = setInterval(async () => {
      await this.reloadRules();
    }, RULE_RELOAD_INTERVAL_MS);

    // Allow the timer to not prevent process exit
    if (this.reloadTimer.unref) {
      this.reloadTimer.unref();
    }
  }

  /**
   * Get the number of currently loaded rules.
   * @returns Number of active rules
   */
  getRuleCount(): number {
    return this.rules.length;
  }

  /**
   * Get cache statistics.
   * @returns Current cache size
   */
  getCacheSize(): number {
    return this.cache.size();
  }
}
