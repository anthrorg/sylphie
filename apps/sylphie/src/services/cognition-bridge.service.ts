/**
 * CognitionBridgeService — bridges the NestJS cognitive loop with the
 * Python cognition sidecar.
 *
 * This service sits at the app level (not in packages/) because it connects
 * two subsystems that shouldn't know about each other:
 *   - DecisionMakingService (response$ Observable, sensory frames)
 *   - CognitionGatewayService (HTTP client to the Python sidecar)
 *
 * Two responsibilities:
 *   1. On each CycleResponse, submit a training sample to the sidecar
 *      (fire-and-forget, async, never blocks the decision loop)
 *   2. Expose the sidecar result for the next cycle via a cache
 *      (the decision-making module can query this without importing the gateway)
 *
 * The bridge subscribes to response$ on init and processes cycles asynchronously.
 * It NEVER touches the hot path — the sidecar call happens after the decision
 * is already made and emitted.
 */

import {
  Injectable,
  Inject,
  Logger,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Subscription } from 'rxjs';
import {
  type CycleResponse,
  type DriveSnapshot,
  type SensoryFrame,
  DRIVE_INDEX_ORDER,
  verboseFor,
} from '@sylphie/shared';
import {
  DECISION_MAKING_SERVICE,
  type IDecisionMakingService,
} from '@sylphie/decision-making';
import { DRIVE_STATE_READER, type IDriveStateReader } from '@sylphie/drive-engine';
import {
  CognitionGatewayService,
  type CognitionCycleResult,
  type CognitionTrainingSample,
} from './cognition-gateway.service';

const vlog = verboseFor('CognitionBridge');

@Injectable()
export class CognitionBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CognitionBridgeService.name);
  private subscription: Subscription | null = null;

  /** Most recent sidecar result — can be queried by other services. */
  private lastSidecarResult: CognitionCycleResult | null = null;

  constructor(
    @Inject(DECISION_MAKING_SERVICE)
    private readonly decisionMaking: IDecisionMakingService,

    @Inject(DRIVE_STATE_READER)
    private readonly driveReader: IDriveStateReader,

    private readonly cognitionGateway: CognitionGatewayService,
  ) {}

  onModuleInit() {
    if (!this.cognitionGateway.isAvailable()) {
      this.logger.log(
        'Cognition sidecar not available — bridge inactive (LLM-only mode)',
      );
    }

    // Subscribe to the response stream to submit training data
    this.subscription = this.decisionMaking.response$.subscribe({
      next: (cycle) => {
        this.onCycleResponse(cycle).catch((err) => {
          this.logger.warn(
            `Training sample submission failed: ${(err as Error).message}`,
          );
        });
      },
    });

    this.logger.log('CognitionBridge active — training samples will be submitted to sidecar');
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
  }

  /**
   * Get the most recent sidecar result.
   * Returns null if sidecar is unavailable or hasn't been called yet.
   */
  getLastResult(): CognitionCycleResult | null {
    return this.lastSidecarResult;
  }

  /**
   * Run the sidecar cycle proactively for a given frame.
   * Called from the cognitive loop when shadow/audit mode is active.
   */
  async runSidecarCycle(
    frame: SensoryFrame,
    driveSnapshot: DriveSnapshot,
  ): Promise<CognitionCycleResult | null> {
    if (!this.cognitionGateway.isAvailable()) return null;

    const result = await this.cognitionGateway.runCycle(
      frame,
      driveSnapshot,
    );

    if (result) {
      this.lastSidecarResult = result;
    }

    return result;
  }

  /**
   * After each decision cycle:
   *   1. Call the sidecar's /cognition/cycle to get the tensor's opinion
   *      (populates last_cycle_result + tensor_top_category on the Python side)
   *   2. Submit a training sample with the LLM's action_category so the
   *      sidecar can compare tensor vs LLM for bootstrap tracking
   *
   * This happens async after the response is already emitted — never on the hot path.
   */
  private async onCycleResponse(cycle: CycleResponse): Promise<void> {
    if (!this.cognitionGateway.isAvailable()) return;

    const driveSnapshot = cycle.driveSnapshot;
    const driveVector = DRIVE_INDEX_ORDER.map(
      (name) => driveSnapshot.pressureVector[name] ?? 0,
    );
    const driveDeltas = DRIVE_INDEX_ORDER.map(
      (name) => driveSnapshot.driveDeltas[name] ?? 0,
    );

    // Step 1: Call the sidecar cycle so it runs inference and populates
    // tensor_top_category. We use zero-filled embeddings since the raw
    // SensoryFrame isn't available via response$. The sidecar's bootstrap
    // comparison only needs tensor_top_category (argmax of action_bias),
    // not the actual embedding quality.
    const zeroEmbedding = new Array(768).fill(0);
    const cycleResult = await this.cognitionGateway.runCycle(
      {
        timestamp: Date.now(),
        fused_embedding: zeroEmbedding,
        modality_embeddings: {},
        active_modalities: [],
        raw: {},
      } as SensoryFrame,
      driveSnapshot,
    );

    if (cycleResult) {
      this.lastSidecarResult = cycleResult;
    }

    // Step 2: Determine action category from the LLM's actual behavior.
    //
    // The arbitration type is often SHRUG (no Type 1 candidates exist yet),
    // but the deliberation pipeline still produces a real response with a
    // meaningful category. Using raw "SHRUG" as the category would mean the
    // tensor model only learns to predict SHRUG, blocking bootstrap graduation.
    //
    // Instead, derive the category from what actually happened:
    //   - If arbitration found a procedure → use its category
    //   - If deliberation produced a grounded response → "ConversationalResponse"
    //   - If deliberation produced an LLM-assisted response → "KnowledgeQuery"
    //   - If no response was generated → "SHRUG"
    let actionCategory: string | undefined;
    if (
      cycle.arbitrationResult.type !== 'SHRUG' &&
      cycle.arbitrationResult.candidate?.procedureData
    ) {
      actionCategory =
        cycle.arbitrationResult.candidate.procedureData.category ??
        cycle.arbitrationResult.candidate.procedureData.name;
    } else if (cycle.text.length > 0) {
      // Deliberation produced a response even though arbitration was SHRUG.
      // Categorize by grounding level — this is the closest signal we have
      // to what "kind" of response the LLM produced.
      switch (cycle.knowledgeGrounding) {
        case 'GROUNDED':
          actionCategory = 'ConversationalResponse';
          break;
        case 'LLM_ASSISTED':
          actionCategory = 'KnowledgeQuery';
          break;
        default:
          actionCategory = 'ConversationalResponse';
          break;
      }
    } else {
      actionCategory = 'SHRUG';
    }

    // Step 3: Submit training sample. The sidecar's /cognition/train endpoint
    // will compare sample.action_category (LLM) against last_cycle_result.tensor_top_category
    // (tensor) for bootstrap agreement tracking.
    const sample: CognitionTrainingSample = {
      fused_embedding: zeroEmbedding,
      drive_vector: driveVector,
      drive_deltas: driveDeltas,
      total_pressure: driveSnapshot.totalPressure,
      arbitration_type: cycle.arbitrationType,
      action_category: actionCategory,
      outcome: undefined, // Set later by reportOutcome
    };

    this.cognitionGateway.submitTrainingSample(sample);

    vlog('training sample submitted', {
      arbitrationType: cycle.arbitrationType,
      actionCategory,
      tensorTopCategory: cycleResult?.tensor_top_category,
      sidecarInferenceMs: cycleResult?.inference_ms,
    });
  }
}
