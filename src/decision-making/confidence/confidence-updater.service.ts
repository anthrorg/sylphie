/**
 * ACT-R 3-Path Confidence Updater Implementation.
 *
 * CANON §Confidence Dynamics: Updates action procedure confidence via the
 * ACT-R formula: min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))
 *
 * Three update paths:
 * 1. 'reinforced':        Successful use → increment count, update lastRetrievalAt
 * 2. 'decayed':           Time-based decay → recompute with updated time component
 * 3. 'counter_indicated': Outcome contradicted prediction → reduce base by 0.10-0.20
 *
 * CANON Immutable Standard 5 (Guardian Asymmetry): confirmation applies 2x weight,
 * correction applies 3x weight.
 *
 * CANON §Type 1 / Type 2 Discipline: After each update, checks graduation
 * (confidence > 0.80 AND MAE < 0.10) and demotion (MAE > 0.15) thresholds,
 * emitting TYPE_1_GRADUATION or TYPE_1_DEMOTION events accordingly.
 *
 * Since WKG may not be fully wired yet, maintains an in-memory store of action
 * confidence records indexed by actionId.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { IConfidenceUpdaterService } from '../interfaces/decision-making.interfaces';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import { IEventService } from '../../events/interfaces/events.interfaces';
import { createDecisionMakingEvent } from '../../events/builders/event-builders';
import {
  computeConfidence,
  applyGuardianWeight,
  qualifiesForGraduation,
  qualifiesForDemotion,
  type ACTRParams,
  DEFAULT_DECAY_RATES,
} from '../../shared/types/confidence.types';
import type { CoreProvenanceSource } from '../../shared/types/provenance.types';
import { PROVENANCE_BASE_CONFIDENCE } from '../../shared/types/provenance.types';
import type { DriveSnapshot, PressureVector, PressureDelta } from '../../shared/types/drive.types';
import { DriveName, INITIAL_DRIVE_STATE } from '../../shared/types/drive.types';

/**
 * In-memory record of action confidence parameters.
 * Tracks ACT-R state for each actionId.
 */
interface ActionConfidenceRecord {
  readonly actionId: string;
  base: number;
  count: number;
  decayRate: number;
  lastRetrievalAt: Date | null;
  recentMAEs: number[];  // last 10 evaluations
  type1State: 'UNCLASSIFIED' | 'TYPE_2_ONLY' | 'TYPE_1_CANDIDATE' | 'TYPE_1_GRADUATED' | 'TYPE_1_DEMOTED';
  provenance: CoreProvenanceSource;
}

@Injectable()
export class ConfidenceUpdaterService implements IConfidenceUpdaterService {
  private readonly logger = new Logger('ConfidenceUpdaterService');

  /**
   * In-memory store of action confidence records.
   * Key: actionId, Value: ActionConfidenceRecord
   */
  private readonly store = new Map<string, ActionConfidenceRecord>();

  constructor(
    @Inject(EVENTS_SERVICE) private readonly events: IEventService,
  ) {}

  /**
   * Update the ACT-R confidence of an action procedure after outcome observation.
   *
   * Loads or creates the record for actionId, applies the update path (reinforced,
   * decayed, or counter_indicated), applies guardian weight if present, and checks
   * Type 1 graduation/demotion thresholds. Emits TYPE_1_GRADUATION or TYPE_1_DEMOTION
   * events when thresholds are crossed.
   *
   * @param actionId       - WKG procedure node ID of the action to update
   * @param outcome        - 'reinforced' | 'decayed' | 'counter_indicated'
   * @param guardianFeedback - Optional 'confirmation' | 'correction' for weight
   */
  async update(
    actionId: string,
    outcome: 'reinforced' | 'decayed' | 'counter_indicated',
    guardianFeedback?: 'confirmation' | 'correction',
  ): Promise<void> {
    const record = this.getRecord(actionId);
    const confidenceBefore = this.computeCurrentConfidence(record);

    // Step 1: Apply the update path
    switch (outcome) {
      case 'reinforced':
        this.applyReinforced(record);
        break;
      case 'decayed':
        this.applyDecayed(record);
        break;
      case 'counter_indicated':
        this.applyCounterIndicated(record);
        break;
    }

    // Step 2: Compute confidence delta and apply guardian weight
    const confidenceAfter = this.computeCurrentConfidence(record);
    let confidenceDelta = confidenceAfter - confidenceBefore;

    if (guardianFeedback) {
      const weightedDelta = applyGuardianWeight(confidenceDelta, guardianFeedback);
      // Apply the extra weight to base confidence
      record.base += weightedDelta - confidenceDelta;
      confidenceDelta = weightedDelta;
    }

    // Clamp base to valid range
    record.base = Math.max(0, Math.min(1, record.base));

    // Step 3: Recompute final confidence and check thresholds
    const newConfidence = this.computeCurrentConfidence(record);
    const recentMAE = record.recentMAEs.length > 0
      ? record.recentMAEs.reduce((a, b) => a + b, 0) / record.recentMAEs.length
      : 0;

    const oldState = record.type1State;
    const hasGraduated = record.type1State === 'TYPE_1_GRADUATED';

    // Step 4: Check demotion (only for already-graduated behaviors)
    if (hasGraduated && qualifiesForDemotion(recentMAE)) {
      record.type1State = 'TYPE_1_DEMOTED';
      this.logger.log(
        `TYPE_1_DEMOTION: actionId=${actionId}, MAE=${recentMAE.toFixed(3)}, confidence=${newConfidence.toFixed(3)}`
      );
      // Emit TYPE_1_DEMOTION event with empty drive snapshot (will be populated by caller)
      // For now, we create a minimal stub to satisfy the type system
      const emptyDriveSnapshot = this.createEmptyDriveSnapshot();
      await this.events.record(
        (createDecisionMakingEvent as any)('TYPE_1_DEMOTION', {
          sessionId: 'unknown',
          driveSnapshot: emptyDriveSnapshot,
        })
      );
    }
    // Step 5: Check graduation (for non-demoted behaviors)
    else if (record.type1State !== 'TYPE_1_DEMOTED' && qualifiesForGraduation(newConfidence, recentMAE)) {
      record.type1State = 'TYPE_1_GRADUATED';
      this.logger.log(
        `TYPE_1_GRADUATION: actionId=${actionId}, confidence=${newConfidence.toFixed(3)}, MAE=${recentMAE.toFixed(3)}`
      );
      // Emit TYPE_1_GRADUATION event
      const emptyDriveSnapshot = this.createEmptyDriveSnapshot();
      await this.events.record(
        (createDecisionMakingEvent as any)('TYPE_1_GRADUATION', {
          sessionId: 'unknown',
          driveSnapshot: emptyDriveSnapshot,
        })
      );
    }

    this.logger.debug(
      `update: actionId=${actionId}, outcome=${outcome}, confidence: ${confidenceBefore.toFixed(3)} → ${newConfidence.toFixed(3)}, state: ${oldState} → ${record.type1State}`
    );
  }

  /**
   * Look up or create a record for the given actionId.
   * Initializes with defaults if not found.
   */
  private getRecord(actionId: string): ActionConfidenceRecord {
    let record = this.store.get(actionId);

    if (!record) {
      // Create new record with LLM_GENERATED defaults
      // (most common case; real WKG integration would read provenance)
      const provenance: CoreProvenanceSource = 'LLM_GENERATED';
      record = {
        actionId,
        base: PROVENANCE_BASE_CONFIDENCE[provenance],
        count: 0,
        decayRate: DEFAULT_DECAY_RATES[provenance],
        lastRetrievalAt: null,
        recentMAEs: [],
        type1State: 'UNCLASSIFIED',
        provenance,
      };
      this.store.set(actionId, record);
    }

    return record;
  }

  /**
   * Compute current confidence for the given record using the ACT-R formula.
   */
  private computeCurrentConfidence(record: ActionConfidenceRecord): number {
    const params: ACTRParams = {
      base: record.base,
      count: record.count,
      decayRate: record.decayRate,
      lastRetrievalAt: record.lastRetrievalAt,
    };
    return computeConfidence(params);
  }

  /**
   * Apply 'reinforced' path: increment count, update lastRetrievalAt.
   */
  private applyReinforced(record: ActionConfidenceRecord): void {
    record.count += 1;
    record.lastRetrievalAt = new Date();
  }

  /**
   * Apply 'decayed' path: recompute confidence with updated time component.
   * (No state change to the record, confidence recalculation happens naturally
   * due to time decay in the formula.)
   */
  private applyDecayed(_record: ActionConfidenceRecord): void {
    // Time-based decay is applied automatically in computeConfidence() via
    // the lastRetrievalAt timestamp. This path is a no-op here; the decay
    // happens when confidence is recomputed.
  }

  /**
   * Apply 'counter_indicated' path: reduce base by 0.10-0.20 proportional to error.
   * For now, use a fixed reduction of 0.15.
   */
  private applyCounterIndicated(record: ActionConfidenceRecord): void {
    // Reduce base confidence due to prediction mismatch
    const reduction = 0.15;
    record.base = Math.max(0, record.base - reduction);
  }

  /**
   * Create an empty/default DriveSnapshot for event emission.
   * Used when events are emitted outside of the normal decision cycle context.
   * A real implementation would receive the actual DriveSnapshot from the caller.
   */
  private createEmptyDriveSnapshot(): DriveSnapshot {
    // Create a zero pressure vector
    const zeroVector: PressureVector = {
      [DriveName.SystemHealth]: 0,
      [DriveName.MoralValence]: 0,
      [DriveName.Integrity]: 0,
      [DriveName.CognitiveAwareness]: 0,
      [DriveName.Guilt]: 0,
      [DriveName.Curiosity]: 0,
      [DriveName.Boredom]: 0,
      [DriveName.Anxiety]: 0,
      [DriveName.Satisfaction]: 0,
      [DriveName.Sadness]: 0,
      [DriveName.InformationIntegrity]: 0,
      [DriveName.Social]: 0,
    };

    const zeroDeltas: PressureDelta = zeroVector;

    return {
      pressureVector: zeroVector,
      timestamp: new Date(),
      tickNumber: 0,
      driveDeltas: zeroDeltas,
      ruleMatchResult: {
        ruleId: null,
        eventType: 'TYPE_1_GRADUATION',
        matched: false,
      },
      totalPressure: 0,
      sessionId: 'unknown',
    };
  }
}
