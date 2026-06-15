/**
 * InterventionTrackerService — tracks supervisor interventions across their
 * full lifecycle: proposed → applied / rejected → outcome_observed.
 *
 * Before this, an intervention was a fire-and-forget HTTP call to the sidecar:
 * we never recorded that it was proposed, whether the sidecar accepted it, or
 * whether the cycles that followed got better or worse. That made interventions
 * un-auditable — the operator could not answer "did the supervisor's correction
 * actually help?".
 *
 * This service keeps a bounded in-memory ring of InterventionRecords (the live,
 * queryable view for the status endpoint) and forwards each lifecycle
 * transition to the same TimescaleDB audit trail as verdicts, so the trail
 * survives a restart.
 *
 * It is observation-only: it never mutates drives, never calls the sidecar, and
 * never blocks. CANON §Guardian Asymmetry is unaffected — this only records.
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TimescaleService } from '@sylphie/shared';
import type {
  InterventionPhase,
  InterventionRecord,
  SupervisorIntervention,
} from './interfaces/supervisor.types';

/** Bounded ring size for the live status view. */
const RECORD_RING_SIZE = 100;

@Injectable()
export class InterventionTrackerService {
  private readonly logger = new Logger(InterventionTrackerService.name);

  private readonly records: InterventionRecord[] = [];
  private readonly byId = new Map<string, InterventionRecord>();

  constructor(
    @Optional() @Inject(TimescaleService) private readonly timescale: TimescaleService | null,
  ) {}

  /**
   * Record an intervention as `proposed`. Returns the generated id, which the
   * caller threads through application/outcome transitions.
   */
  proposed(intervention: SupervisorIntervention): string {
    const interventionId = randomUUID();
    const now = new Date();

    const record: InterventionRecord = {
      interventionId,
      intervention,
      currentPhase: 'proposed',
      transitions: [{ phase: 'proposed', at: now }],
      createdAt: now,
      updatedAt: now,
    };

    this.records.push(record);
    this.byId.set(interventionId, record);
    if (this.records.length > RECORD_RING_SIZE) {
      const evicted = this.records.shift();
      if (evicted) this.byId.delete(evicted.interventionId);
    }

    this.persistTransition(record, 'proposed');
    return interventionId;
  }

  /** Transition an intervention to `applied` (sidecar accepted + executed). */
  applied(interventionId: string, detail?: string): void {
    this.transition(interventionId, 'applied', detail);
  }

  /** Transition an intervention to `rejected` (sidecar refused). */
  rejected(interventionId: string, detail?: string): void {
    this.transition(interventionId, 'rejected', detail);
  }

  /**
   * Attribute an observed outcome to an intervention, closing the loop.
   *
   * @param outcome 'positive' | 'negative' | 'neutral' — whether cycles after
   *                the intervention improved.
   */
  outcomeObserved(
    interventionId: string,
    outcome: 'positive' | 'negative' | 'neutral',
    detail?: string,
  ): void {
    const record = this.byId.get(interventionId);
    if (!record) return;
    record.outcome = outcome;
    this.transition(interventionId, 'outcome_observed', detail ?? outcome);
  }

  /**
   * Records that have been `applied` but whose outcome is not yet observed.
   * The supervisor uses this to close the loop: a later verdict attributes a
   * proxy outcome to each. Live references (caller does not mutate).
   */
  awaitingOutcome(): InterventionRecord[] {
    return this.records.filter((r) => r.currentPhase === 'applied');
  }

  /** Snapshot of recent intervention records (most recent last). */
  getRecent(limit = 20): InterventionRecord[] {
    return this.records.slice(-limit).map((r) => ({
      ...r,
      transitions: [...r.transitions],
    }));
  }

  /** Look up a single record by id (live reference). */
  get(interventionId: string): InterventionRecord | undefined {
    return this.byId.get(interventionId);
  }

  // ---------------------------------------------------------------------------

  private transition(
    interventionId: string,
    phase: InterventionPhase,
    detail?: string,
  ): void {
    const record = this.byId.get(interventionId);
    if (!record) {
      this.logger.warn(
        `Transition to ${phase} for unknown intervention ${interventionId}`,
      );
      return;
    }
    const at = new Date();
    record.transitions.push({ phase, at, detail });
    record.currentPhase = phase;
    record.updatedAt = at;
    this.persistTransition(record, phase, detail);
  }

  /**
   * Forward a lifecycle transition to the TimescaleDB audit trail. Best-effort,
   * non-throwing — observability must never break the supervisor.
   */
  private persistTransition(
    record: InterventionRecord,
    phase: InterventionPhase,
    detail?: string,
  ): void {
    if (!this.timescale) return;

    const payload = {
      interventionId: record.interventionId,
      phase,
      detail: detail ?? null,
      interventionType: record.intervention.type,
      source: record.intervention.source,
      cycleId: record.intervention.cycleId ?? null,
      outcome: record.outcome ?? null,
    };

    const sql =
      `INSERT INTO events (id, type, timestamp, subsystem, session_id, drive_snapshot, payload, correlation_id, schema_version) ` +
      `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
    const params = [
      randomUUID(),
      'SUPERVISOR_INTERVENTION',
      new Date(),
      'SUPERVISOR',
      record.intervention.cycleId ?? record.interventionId,
      null,
      JSON.stringify(payload),
      record.interventionId,
      1,
    ];

    this.timescale.query(sql, params).catch((err) => {
      this.logger.error(
        `Failed to persist intervention transition (${phase}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}
