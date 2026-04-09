/**
 * PlanningService -- Maintenance cycle orchestrator for the Planning subsystem.
 *
 * CANON SS Subsystem 5 (Planning): Converts Opportunities detected by the Drive
 * Engine into new behavioral procedures (ActionProcedure nodes in the WKG)
 * through a research -> simulation -> proposal -> validation -> creation pipeline.
 *
 * Cycle trigger: Two timers:
 *   1. Processing timer (PROCESSING_INTERVAL_MS): dequeue top opportunity, run pipeline.
 *   2. Decay timer (DECAY_INTERVAL_MS): apply priority decay, drop stale opportunities.
 *
 * Overlap guard: pipelineInFlight prevents concurrent cycles. If a cycle is still
 * running when the timer fires, the new tick is dropped silently.
 *
 * Data source: Polls TimescaleDB for unprocessed OPPORTUNITY_DETECTED events
 * (written by DriveProcessManagerService). This follows the event backbone pattern
 * used by Learning (has_learned=false polling).
 *
 * CANON SS No Circular Module Dependencies: Cross-subsystem communication flows
 * through TimescaleDB, not direct service injection.
 */

import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { TimescaleService, verboseFor } from '@sylphie/shared';
import type { OpportunityCreatedPayload } from '@sylphie/shared';

const vlog = verboseFor('Planning');
import type {
  IPlanningService,
  PlanningCycleResult,
  OpportunityQueueStatus,
  PlanOutcomeData,
  IOpportunityQueue,
  IResearchService,
  ISimulationService,
  IProposalService,
  IConstraintValidationService,
  IProcedureCreationService,
  IPlanEvaluationService,
  IPlanningEventLogger,
  QueuedOpportunity,
} from './interfaces/planning.interfaces';
import {
  OPPORTUNITY_QUEUE,
  RESEARCH_SERVICE,
  SIMULATION_SERVICE,
  PROPOSAL_SERVICE,
  CONSTRAINT_VALIDATION_SERVICE,
  PROCEDURE_CREATION_SERVICE,
  PLAN_EVALUATION_SERVICE,
  PLANNING_EVENT_LOGGER,
} from './planning.tokens';
import { priorityToNumeric } from './queue/opportunity-queue.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Interval between pipeline processing ticks in milliseconds. */
const PROCESSING_INTERVAL_MS = 30_000;

/** Interval between decay sweeps in milliseconds. */
const DECAY_INTERVAL_MS = 60_000;

/** Maximum unprocessed opportunities to ingest per polling cycle. */
const MAX_INGEST_PER_CYCLE = 10;

/**
 * Maximum PREDICTION_EVALUATED outcomes to process per outcome-polling cycle.
 * Each evaluation involves a TimescaleDB UPDATE, so we cap the batch to prevent
 * the evaluation loop from dominating the I/O budget.
 */
const MAX_OUTCOMES_PER_CYCLE = 20;

// ---------------------------------------------------------------------------
// PlanningService
// ---------------------------------------------------------------------------

@Injectable()
export class PlanningService implements IPlanningService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlanningService.name);

  /** Guard against overlapping pipeline runs. */
  private pipelineInFlight = false;

  /** Timer handles for cleanup in onModuleDestroy. */
  private processingTimer: ReturnType<typeof setInterval> | null = null;
  private decayTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(OPPORTUNITY_QUEUE)
    private readonly queue: IOpportunityQueue,

    @Inject(RESEARCH_SERVICE)
    private readonly research: IResearchService,

    @Inject(SIMULATION_SERVICE)
    private readonly simulation: ISimulationService,

    @Inject(PROPOSAL_SERVICE)
    private readonly proposal: IProposalService,

    @Inject(CONSTRAINT_VALIDATION_SERVICE)
    private readonly constraintValidation: IConstraintValidationService,

    @Inject(PROCEDURE_CREATION_SERVICE)
    private readonly procedureCreation: IProcedureCreationService,

    @Inject(PLAN_EVALUATION_SERVICE)
    private readonly planEvaluation: IPlanEvaluationService,

    @Inject(PLANNING_EVENT_LOGGER)
    private readonly eventLogger: IPlanningEventLogger,

    private readonly timescale: TimescaleService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onModuleInit(): void {
    // Processing timer: ingest new opportunities from TimescaleDB, then run pipeline.
    this.processingTimer = setInterval(() => {
      this.ingestAndProcess().catch((err: unknown) => {
        this.logger.error(
          `Planning cycle threw an unhandled error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, PROCESSING_INTERVAL_MS);

    // Decay timer: sweep the queue for stale opportunities.
    this.decayTimer = setInterval(() => {
      const dropped = this.queue.applyDecay();
      if (dropped > 0) {
        this.eventLogger.log('OPPORTUNITY_DROPPED', {
          droppedCount: dropped,
          remainingQueueSize: this.queue.size(),
          reason: 'priority_decay',
        });
      }
    }, DECAY_INTERVAL_MS);

    this.logger.log(
      `Planning subsystem started -- processing every ${PROCESSING_INTERVAL_MS / 1000}s, ` +
        `decay sweep every ${DECAY_INTERVAL_MS / 1000}s`,
    );
  }

  onModuleDestroy(): void {
    if (this.processingTimer !== null) {
      clearInterval(this.processingTimer);
      this.processingTimer = null;
    }
    if (this.decayTimer !== null) {
      clearInterval(this.decayTimer);
      this.decayTimer = null;
    }
    this.logger.log('Planning subsystem stopped');
  }

  // ---------------------------------------------------------------------------
  // IPlanningService
  // ---------------------------------------------------------------------------

  async processNextOpportunity(): Promise<PlanningCycleResult> {
    if (this.pipelineInFlight) {
      this.logger.debug('Pipeline already in flight -- skipping this tick');
      return noop();
    }

    this.pipelineInFlight = true;

    try {
      return await this.executePipeline();
    } finally {
      this.pipelineInFlight = false;
    }
  }

  getQueueStatus(): OpportunityQueueStatus {
    return this.queue.getStatus();
  }

  async evaluatePlanOutcome(procedureId: string, outcome: PlanOutcomeData): Promise<void> {
    await this.planEvaluation.evaluateOutcome(procedureId, outcome);
  }

  // ---------------------------------------------------------------------------
  // Private: Ingest + Process
  // ---------------------------------------------------------------------------

  /**
   * Poll TimescaleDB for unprocessed OPPORTUNITY_DETECTED events, enqueue them,
   * then run the pipeline on the highest-priority opportunity. Also polls for
   * post-execution outcomes of Planning-created procedures so evaluatePlanOutcome()
   * is called with real feedback data.
   */
  private async ingestAndProcess(): Promise<void> {
    await this.ingestOpportunities();
    await this.pollAndEvaluateOutcomes();
    await this.processNextOpportunity();
  }

  /**
   * Poll TimescaleDB for OPPORTUNITY_DETECTED events that have not yet been
   * ingested by Planning (has_planned = false).
   */
  private async ingestOpportunities(): Promise<void> {
    try {
      const result = await this.timescale.query<{
        id: string;
        payload: string;
      }>(
        `SELECT id, payload FROM events
         WHERE type IN ('OPPORTUNITY_DETECTED', 'GUARDIAN_TEACHING_DETECTED')
           AND (payload->>'has_planned')::boolean IS NOT TRUE
         ORDER BY timestamp ASC
         LIMIT $1`,
        [MAX_INGEST_PER_CYCLE],
      );

      for (const row of result.rows) {
        const opportunityPayload: OpportunityCreatedPayload = JSON.parse(
          typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload),
        );

        vlog('opportunity received', {
          opportunityId: opportunityPayload.id,
          classification: opportunityPayload.classification,
          priority: opportunityPayload.priority,
          contextFingerprint: opportunityPayload.contextFingerprint,
          affectedDrive: opportunityPayload.affectedDrive,
        });

        this.eventLogger.log('OPPORTUNITY_RECEIVED', {
          opportunityId: opportunityPayload.id,
          classification: opportunityPayload.classification,
          priority: opportunityPayload.priority,
        });

        const queued: QueuedOpportunity = {
          payload: opportunityPayload,
          enqueuedAt: new Date(),
          initialPriority: priorityToNumeric(opportunityPayload.priority, opportunityPayload.classification),
          currentPriority: priorityToNumeric(opportunityPayload.priority, opportunityPayload.classification),
        };

        const accepted = this.queue.enqueue(queued);

        if (accepted) {
          vlog('opportunity enqueued', {
            opportunityId: opportunityPayload.id,
            queueSize: this.queue.size(),
            classification: opportunityPayload.classification,
            initialPriority: queued.initialPriority,
          });

          this.eventLogger.log('OPPORTUNITY_INTAKE', {
            opportunityId: opportunityPayload.id,
            queueSize: this.queue.size(),
            classification: opportunityPayload.classification,
          });

          // Guardian teaching gets immediate processing -- don't wait for the 30s timer.
          if (opportunityPayload.classification === 'GUARDIAN_TEACHING') {
            this.logger.log(
              `Guardian teaching detected -- triggering immediate pipeline for ${opportunityPayload.id}`,
            );
            setImmediate(() => {
              this.processNextOpportunity().catch((err: unknown) => {
                this.logger.error(
                  `Immediate guardian teaching pipeline failed: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              });
            });
          }
        } else {
          // Check if rate-limited (vs duplicate/cap)
          const status = this.queue.getStatus();
          if (status.plansCreatedInWindow >= status.rateLimitMax) {
            this.eventLogger.log('PLANNING_RATE_LIMITED', {
              opportunityId: opportunityPayload.id,
              plansCreatedInWindow: status.plansCreatedInWindow,
            });
          }
        }

        // Mark as ingested in TimescaleDB so we don't re-poll it.
        await this.timescale.query(
          `UPDATE events
           SET payload = jsonb_set(
             COALESCE(payload::jsonb, '{}'::jsonb),
             '{has_planned}',
             'true'::jsonb
           )
           WHERE id = $1`,
          [row.id],
        );
      }
    } catch (err) {
      this.logger.warn(
        `Failed to ingest opportunities: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Outcome polling
  // ---------------------------------------------------------------------------

  /**
   * Poll TimescaleDB for PREDICTION_EVALUATED outcomes that belong to
   * Planning-created procedures, then call evaluatePlanOutcome() for each.
   *
   * How it works:
   *   1. Join PREDICTION_EVALUATED (owns mae + accurate + actualEffects) with
   *      PREDICTION_CREATED (owns actionId = the WKG procedure node ID) on
   *      predictionId.
   *   2. Filter to rows where the actionId from PREDICTION_CREATED matches the
   *      procedureNodeId stored in a PLAN_CREATED event payload -- meaning the
   *      action was one Planning originally created.
   *   3. Skip rows already processed by Planning (has_plan_evaluated = true).
   *   4. Mark each processed row so it is not re-evaluated on the next cycle.
   *
   * This is deliberately fire-and-forget per row: a single bad row does not
   * abort the loop. Each failure is logged at warn level.
   *
   * CANON §No Circular Module Dependencies: Planning never calls Decision Making
   * services directly. Communication is through the TimescaleDB event backbone.
   */
  private async pollAndEvaluateOutcomes(): Promise<void> {
    let rows: Array<{
      eval_id: string;
      eval_payload: string;
      create_payload: string;
    }> = [];

    try {
      const result = await this.timescale.query<{
        eval_id: string;
        eval_payload: string;
        create_payload: string;
      }>(
        // Find PREDICTION_EVALUATED events for procedures that Planning created.
        //
        // pe = PREDICTION_EVALUATED (contains mae, accurate, actualEffects)
        // pc = PREDICTION_CREATED   (contains predictionId + actionId)
        // pla = PLAN_CREATED        (contains procedureNodeId -- Planning's ID)
        //
        // We join pe <-> pc on predictionId, then filter to only those whose
        // actionId appears in a PLAN_CREATED payload.
        `SELECT pe.id AS eval_id,
                pe.payload AS eval_payload,
                pc.payload AS create_payload
         FROM events pe
         JOIN events pc
           ON pc.type = 'PREDICTION_CREATED'
          AND (pc.payload->>'predictionId') = (pe.payload->>'predictionId')
         WHERE pe.type = 'PREDICTION_EVALUATED'
           AND (pe.payload->>'has_plan_evaluated')::boolean IS NOT TRUE
           AND EXISTS (
                 SELECT 1 FROM events pla
                 WHERE pla.type = 'PLAN_CREATED'
                   AND (pla.payload->>'procedureNodeId') = (pc.payload->>'actionId')
               )
         ORDER BY pe.timestamp ASC
         LIMIT $1`,
        [MAX_OUTCOMES_PER_CYCLE],
      );

      rows = result.rows;
    } catch (err) {
      this.logger.warn(
        `pollAndEvaluateOutcomes: query failed -- ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    if (rows.length === 0) {
      return;
    }

    vlog('outcome poll', { count: rows.length });

    for (const row of rows) {
      try {
        const evalPayload: Record<string, unknown> = JSON.parse(
          typeof row.eval_payload === 'string'
            ? row.eval_payload
            : JSON.stringify(row.eval_payload),
        );
        const createPayload: Record<string, unknown> = JSON.parse(
          typeof row.create_payload === 'string'
            ? row.create_payload
            : JSON.stringify(row.create_payload),
        );

        const procedureId = createPayload['actionId'] as string | undefined;
        if (!procedureId) {
          this.logger.warn(
            `pollAndEvaluateOutcomes: PREDICTION_CREATED row missing actionId, skipping`,
          );
          continue;
        }

        const mae = typeof evalPayload['mae'] === 'number' ? evalPayload['mae'] : 1.0;
        const accurate = evalPayload['accurate'] === true;
        const actualEffects = (evalPayload['actualEffects'] ?? {}) as Partial<Record<string, number>>;

        const outcome: PlanOutcomeData = {
          procedureId,
          executionSuccessful: accurate,
          driveEffectsObserved: actualEffects as PlanOutcomeData['driveEffectsObserved'],
          predictionAccurate: accurate,
          mae,
        };

        vlog('evaluating plan outcome', {
          procedureId,
          mae: +mae.toFixed(4),
          accurate,
          evalEventId: row.eval_id,
        });

        await this.evaluatePlanOutcome(procedureId, outcome);

        // Mark as processed so we do not re-evaluate on the next cycle.
        await this.timescale.query(
          `UPDATE events
           SET payload = jsonb_set(
             COALESCE(payload::jsonb, '{}'::jsonb),
             '{has_plan_evaluated}',
             'true'::jsonb
           )
           WHERE id = $1`,
          [row.eval_id],
        );
      } catch (err) {
        this.logger.warn(
          `pollAndEvaluateOutcomes: failed to evaluate outcome for eval_id=${row.eval_id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Full pipeline
  // ---------------------------------------------------------------------------

  private async executePipeline(): Promise<PlanningCycleResult> {
    const opportunity = this.queue.dequeue();
    if (!opportunity) {
      return noop();
    }

    const oppId = opportunity.payload.id;

    vlog('pipeline start', {
      opportunityId: oppId,
      classification: opportunity.payload.classification,
      priority: opportunity.currentPriority,
      affectedDrive: opportunity.payload.affectedDrive,
      contextFingerprint: opportunity.payload.contextFingerprint,
    });

    this.logger.log(
      `Planning pipeline: processing opportunity ${oppId} ` +
        `(${opportunity.payload.classification}, priority=${opportunity.currentPriority.toFixed(2)})`,
    );

    // Step 1: Research
    const researchResult = await this.research.research(opportunity);

    if (!researchResult.sufficient) {
      this.eventLogger.log('RESEARCH_INSUFFICIENT', {
        opportunityId: oppId,
        eventFrequency: researchResult.eventFrequency,
        recentOccurrences: researchResult.recentOccurrences,
      });
      this.logger.debug(`Research insufficient for ${oppId}`);
      return { wasNoop: false, opportunityId: oppId, stage: 'RESEARCH', procedureNodeId: null };
    }

    this.eventLogger.log('RESEARCH_COMPLETED', {
      opportunityId: oppId,
      eventFrequency: researchResult.eventFrequency,
      recentOccurrences: researchResult.recentOccurrences,
      patternCount: researchResult.contextPatterns.length,
    });

    // Step 2: Simulation
    const simulationResult = await this.simulation.simulate(opportunity, researchResult);

    if (!simulationResult.viable) {
      this.eventLogger.log('SIMULATION_NO_VIABLE', {
        opportunityId: oppId,
        outcomesEvaluated: simulationResult.outcomes.length,
      });
      this.logger.debug(`No viable simulation outcomes for ${oppId}`);
      return { wasNoop: false, opportunityId: oppId, stage: 'SIMULATION', procedureNodeId: null };
    }

    this.eventLogger.log('SIMULATION_COMPLETED', {
      opportunityId: oppId,
      viableOutcomes: simulationResult.outcomes.length,
      bestRiskScore: simulationResult.bestOutcome?.riskScore ?? null,
    });

    // Step 3: Proposal
    const planProposal = await this.proposal.propose(
      opportunity,
      researchResult,
      simulationResult,
    );

    this.eventLogger.log('PROPOSAL_GENERATED', {
      opportunityId: oppId,
      proposalName: planProposal.name,
      actionStepCount: planProposal.actionSequence.length,
    });

    // Step 4: Constraint Validation (with retry loop)
    this.eventLogger.log('PLAN_PROPOSED', {
      opportunityId: oppId,
      proposalName: planProposal.name,
    });

    let currentProposal = planProposal;
    const validationResult = await this.constraintValidation.validate(
      currentProposal,
      opportunity,
    );

    if (validationResult.deferred) {
      // LLM unavailable -- re-enqueue the opportunity for later.
      this.logger.warn(`LLM unavailable -- deferring opportunity ${oppId}`);
      this.queue.enqueue(opportunity);
      return { wasNoop: false, opportunityId: oppId, stage: 'VALIDATION', procedureNodeId: null };
    }

    if (!validationResult.passed) {
      this.eventLogger.log('PLAN_VALIDATION_FAILED', {
        opportunityId: oppId,
        reasoning: validationResult.reasoning,
        violations: validationResult.violations,
        attemptsUsed: validationResult.attemptsUsed,
      });
      this.logger.debug(
        `Plan validation failed for ${oppId} after ${validationResult.attemptsUsed} attempts`,
      );
      return { wasNoop: false, opportunityId: oppId, stage: 'VALIDATION', procedureNodeId: null };
    }

    this.eventLogger.log('PLAN_VALIDATED', {
      opportunityId: oppId,
      attemptsUsed: validationResult.attemptsUsed,
    });

    // Step 5: Create procedure in WKG
    try {
      const nodeId = await this.procedureCreation.createProcedure(
        currentProposal,
        opportunity,
      );

      this.queue.recordPlanCreated();

      vlog('pipeline complete — procedure created', {
        opportunityId: oppId,
        procedureNodeId: nodeId,
        proposalName: currentProposal.name,
        category: currentProposal.category,
        isGuardianTeaching: opportunity.payload.classification === 'GUARDIAN_TEACHING',
        predictedDriveEffects: currentProposal.predictedDriveEffects,
      });

      this.eventLogger.log('PLAN_CREATED', {
        opportunityId: oppId,
        procedureNodeId: nodeId,
        proposalName: currentProposal.name,
        category: currentProposal.category,
        predictedDriveEffects: currentProposal.predictedDriveEffects,
        isGuardianTeaching: opportunity.payload.classification === 'GUARDIAN_TEACHING',
      });

      this.logger.log(
        `Plan created: ${currentProposal.name} (node=${nodeId}) for opportunity ${oppId}`,
      );

      return { wasNoop: false, opportunityId: oppId, stage: 'CREATED', procedureNodeId: nodeId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vlog('pipeline failed — procedure creation error', { opportunityId: oppId, error: message });
      this.eventLogger.log('PLAN_FAILURE', {
        opportunityId: oppId,
        error: message,
      });
      this.logger.error(`Procedure creation failed for ${oppId}: ${message}`);
      return { wasNoop: false, opportunityId: oppId, stage: 'CREATED', procedureNodeId: null };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noop(): PlanningCycleResult {
  return {
    wasNoop: true,
    opportunityId: null,
    stage: 'NONE',
    procedureNodeId: null,
  };
}
