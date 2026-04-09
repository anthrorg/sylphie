/**
 * SupervisorService — DeepSeek reasoning model observer for the cognitive pipeline.
 *
 * CANON §Guardian Asymmetry: The supervisor's weight (0.5x) is always below
 * the guardian's (2x/3x). Jim can override any supervisor verdict.
 *
 * The supervisor:
 *   1. Subscribes to DecisionMakingService.response$ (async, never on hot path)
 *   2. Builds a compact DecisionNarration from each CycleResponse
 *   3. Evaluates it via DeepSeek-reasoner (sampled, budget-limited)
 *   4. Emits SupervisorVerdict via verdict$ for downstream consumption
 *   5. Optionally feeds verdicts into reportOutcome() as synthetic feedback
 *
 * The supervisor NEVER blocks the cognitive loop. It processes cycles
 * asynchronously and at a lower frequency (1-in-N sampling).
 */

import {
  Injectable,
  Inject,
  Logger,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject, Subscription, type Observable } from 'rxjs';
import {
  type CycleResponse,
  type ILlmService,
  LLM_SERVICE,
  verboseFor,
} from '@sylphie/shared';
import {
  DECISION_MAKING_SERVICE,
  type IDecisionMakingService,
} from '@sylphie/decision-making';
import { NarrationBuilderService } from './narration-builder.service';
import { CostTrackerService } from './cost-tracker.service';
import { SidecarControlService } from './sidecar-control.service';
import type {
  DecisionNarration,
  SupervisorVerdict,
  SupervisorIntervention,
  SamplingPolicy,
  SupervisorStatus,
  VerdictRating,
} from './interfaces/supervisor.types';

const vlog = verboseFor('Supervisor');

/** Maximum number of recent verdicts to keep in memory. */
const VERDICT_BUFFER_SIZE = 100;

/** System prompt for the DeepSeek reasoning supervisor. */
const SUPERVISOR_SYSTEM_PROMPT = `You are the cognitive supervisor for Sylphie, an AI companion with drive-based cognition and a learned tensor pipeline.

You receive decision narrations — compact summaries of one cognitive cycle — and evaluate whether the decision was appropriate.

Evaluation criteria:
1. Drive alignment: Did the action address the dominant drive pressure? A high-pressure drive that was ignored is concerning.
2. Response quality: Does the response preview seem appropriate for the situation? Watch for non-sequiturs, repetition, or chatbot-speak.
3. Escalation appropriateness: Type 1 should handle familiar patterns; novel or uncertain situations should escalate to Type 2.
4. Consistency: Does this decision align with established behavioral patterns, or is it an unexpected deviation?

You must respond with ONLY a JSON object (no markdown, no explanation outside the JSON):
{
  "verdict": "good" | "acceptable" | "questionable" | "wrong",
  "confidence": 0.0 to 1.0,
  "reasoning": "brief explanation (1-2 sentences)",
  "flag_for_guardian": true or false,
  "flag_reason": "why Jim should look at this (only if flagged)",
  "suggested_correction": null or { "type": "reinforce" | "correct" | "boost_salience", "reason": "why" }
}`;

export interface ISupervisorService {
  /** Observable stream of supervisor verdicts. */
  readonly verdict$: Observable<SupervisorVerdict>;

  /** Current supervisor status (for REST/WebSocket endpoints). */
  getStatus(): SupervisorStatus;

  /** Update sampling policy at runtime (e.g., from player view). */
  updatePolicy(policy: Partial<SamplingPolicy>): void;

  /** Submit a manual intervention (from guardian via player view). */
  submitIntervention(intervention: SupervisorIntervention): void;

  /** Enable or disable the supervisor. */
  setEnabled(enabled: boolean): void;
}

@Injectable()
export class SupervisorService
  implements ISupervisorService, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SupervisorService.name);

  // --- Observables ---
  private readonly verdictSubject = new Subject<SupervisorVerdict>();
  get verdict$(): Observable<SupervisorVerdict> {
    return this.verdictSubject.asObservable();
  }

  // --- State ---
  private enabled: boolean;
  private cycleCount = 0;
  private subscription: Subscription | null = null;
  private readonly recentVerdicts: SupervisorVerdict[] = [];
  private readonly pendingInterventions: SupervisorIntervention[] = [];

  private samplingPolicy: SamplingPolicy;

  constructor(
    @Inject(DECISION_MAKING_SERVICE)
    private readonly decisionMaking: IDecisionMakingService,

    @Optional()
    @Inject(LLM_SERVICE)
    private readonly llm: ILlmService | null,

    private readonly narrationBuilder: NarrationBuilderService,
    private readonly costTracker: CostTrackerService,
    private readonly sidecarControl: SidecarControlService,
    private readonly config: ConfigService,
  ) {
    this.enabled =
      this.config.get<string>('SUPERVISOR_ENABLED', 'true') === 'true';

    const sampleRate = parseInt(
      this.config.get<string>('SUPERVISOR_SAMPLING_RATE', '10'),
      10,
    );

    this.samplingPolicy = {
      sampleRate,
      alwaysEvaluate: ['guardian_feedback', 'attractor_alert'],
      burstMode: false,
      dailyBudgetUsd: parseFloat(
        this.config.get<string>('SUPERVISOR_DAILY_BUDGET_USD', '5.00'),
      ),
    };
  }

  onModuleInit() {
    if (!this.enabled) {
      this.logger.log('Supervisor disabled by configuration');
      return;
    }

    if (!this.llm) {
      this.logger.warn(
        'LLM_SERVICE not available — supervisor will not evaluate cycles',
      );
      return;
    }

    // Subscribe to the decision cycle response stream
    this.subscription = this.decisionMaking.response$.subscribe({
      next: (cycle) => {
        // Fire-and-forget — never block the pipeline
        this.onCycleResponse(cycle).catch((err) => {
          this.logger.error(`Supervisor evaluation failed: ${err.message}`);
        });
      },
      error: (err) => {
        this.logger.error(`response$ subscription error: ${err.message}`);
      },
    });

    this.logger.log(
      `Supervisor active (sample_rate=1/${this.samplingPolicy.sampleRate}, budget=$${this.samplingPolicy.dailyBudgetUsd}/day)`,
    );
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
    this.verdictSubject.complete();
  }

  // ---------------------------------------------------------------------------
  // Core evaluation loop
  // ---------------------------------------------------------------------------

  private async onCycleResponse(cycle: CycleResponse): Promise<void> {
    this.cycleCount++;

    // Sampling gate
    if (!this.shouldEvaluate(cycle)) return;

    // Budget gate
    if (!this.costTracker.hasBudget()) {
      vlog('skipping evaluation — daily budget exhausted');
      return;
    }

    // Build narration
    const narration = this.narrationBuilder.buildNarration(cycle);

    // Call DeepSeek
    const verdict = await this.evaluate(narration);
    if (!verdict) return;

    // Buffer the verdict
    this.recentVerdicts.push(verdict);
    if (this.recentVerdicts.length > VERDICT_BUFFER_SIZE) {
      this.recentVerdicts.shift();
    }

    // Emit for downstream consumers (broadcast service, etc.)
    this.verdictSubject.next(verdict);

    vlog('supervisor verdict', {
      cycleId: verdict.cycleId,
      rating: verdict.rating,
      confidence: verdict.confidence,
      flagged: verdict.flagForGuardian,
      costUsd: verdict.costUsd.toFixed(6),
    });
  }

  /**
   * Determine whether this cycle should be evaluated based on sampling policy.
   */
  private shouldEvaluate(cycle: CycleResponse): boolean {
    if (!this.enabled) return false;
    if (this.samplingPolicy.burstMode) return true;

    // TODO: Check for always-evaluate events (guardian_feedback, attractor_alert)
    // These require wiring into the guardian feedback path.

    // Standard sampling
    return this.cycleCount % this.samplingPolicy.sampleRate === 0;
  }

  /**
   * Call DeepSeek to evaluate a decision narration.
   */
  private async evaluate(
    narration: DecisionNarration,
  ): Promise<SupervisorVerdict | null> {
    if (!this.llm) return null;

    const userMessage = JSON.stringify(narration, null, 0);

    try {
      const response = await this.llm.complete({
        systemPrompt: SUPERVISOR_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
        maxTokens: 300,
        temperature: 0.2,
        tier: 'deep', // Routes to DeepSeek-reasoner via existing OllamaLlmService
        metadata: {
          callerSubsystem: 'LEARNING', // Supervisor is closest to learning feedback
          purpose: 'SUPERVISOR_EVALUATION',
          sessionId: narration.cycleId,
        },
      });

      // Track cost
      const inputTokens = response.tokensUsed.prompt;
      const outputTokens = response.tokensUsed.completion;
      this.costTracker.recordCost(inputTokens, outputTokens);

      // Parse response — LlmResponse uses 'content' not 'text'
      const parsed = this.parseVerdict(response.content, narration.cycleId);
      if (!parsed) return null;

      return {
        ...parsed,
        // DeepSeek reasoning_content is folded into response.content by
        // OllamaLlmService — reasoning trace not separately available yet.
        // TODO: Expose reasoning_content on LlmResponse interface.
        reasoningTrace: undefined,
        inputTokens,
        outputTokens,
        costUsd: response.cost,
      };
    } catch (err) {
      this.logger.warn(
        `DeepSeek evaluation failed for cycle ${narration.cycleId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Parse the LLM's JSON verdict response.
   */
  private parseVerdict(
    text: string,
    cycleId: string,
  ): Omit<
    SupervisorVerdict,
    'reasoningTrace' | 'inputTokens' | 'outputTokens' | 'costUsd'
  > | null {
    try {
      // Extract JSON from potential markdown code blocks
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn('Supervisor response contained no JSON object');
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);

      const validRatings: VerdictRating[] = [
        'good',
        'acceptable',
        'questionable',
        'wrong',
      ];
      const rating: VerdictRating = validRatings.includes(parsed.verdict)
        ? parsed.verdict
        : 'acceptable';

      return {
        cycleId,
        timestamp: new Date(),
        rating,
        confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0.5)),
        reasoning: String(parsed.reasoning ?? 'No reasoning provided'),
        flagForGuardian: Boolean(parsed.flag_for_guardian),
        flagReason: parsed.flag_reason ? String(parsed.flag_reason) : undefined,
        suggestedCorrection: parsed.suggested_correction ?? null,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to parse supervisor verdict: ${(err as Error).message}`,
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getStatus(): SupervisorStatus {
    return {
      enabled: this.enabled,
      samplingPolicy: { ...this.samplingPolicy },
      budgetRemaining: this.costTracker.budgetRemaining(),
      budgetUsedToday: this.costTracker.budgetUsedToday(),
      totalVerdicts: this.recentVerdicts.length,
      recentVerdicts: this.recentVerdicts.slice(-20),
      flaggedCount: this.recentVerdicts.filter((v) => v.flagForGuardian).length,
    };
  }

  updatePolicy(policy: Partial<SamplingPolicy>): void {
    Object.assign(this.samplingPolicy, policy);
    this.logger.log(
      `Sampling policy updated: rate=1/${this.samplingPolicy.sampleRate}, burst=${this.samplingPolicy.burstMode}`,
    );
  }

  submitIntervention(intervention: SupervisorIntervention): void {
    this.pendingInterventions.push(intervention);
    this.logger.log(
      `Intervention: ${intervention.type} from ${intervention.source}`,
    );

    // Forward to cognition-service sidecar control channel
    this.sidecarControl
      .executeIntervention(intervention)
      .then((result) => {
        if (!result.accepted) {
          this.logger.warn(
            `Sidecar rejected intervention ${intervention.type}: ${result.error}`,
          );
        }
      })
      .catch((err) => {
        this.logger.warn(
          `Sidecar intervention failed: ${(err as Error).message}`,
        );
      });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.logger.log(`Supervisor ${enabled ? 'enabled' : 'disabled'}`);

    if (enabled && !this.subscription && this.llm) {
      this.onModuleInit();
    } else if (!enabled && this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
  }
}
