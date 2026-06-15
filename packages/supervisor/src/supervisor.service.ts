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
  ATTRACTOR_MONITOR_SERVICE,
  type AttractorMonitorService,
} from '@sylphie/decision-making';
import { NarrationBuilderService } from './narration-builder.service';
import { CostTrackerService } from './cost-tracker.service';
import { SidecarControlService } from './sidecar-control.service';
import { VerdictAuditService } from './verdict-audit.service';
import { InterventionTrackerService } from './intervention-tracker.service';
import { AdaptiveSamplerService } from './adaptive-sampler.service';
import type {
  DecisionNarration,
  SupervisorVerdict,
  SupervisorIntervention,
  SamplingPolicy,
  SupervisorStatus,
  VerdictRating,
  EvaluationReason,
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

  /** Model identifier of the most recent verdict (for audit provenance). */
  private model = 'deepseek-reasoner';

  /**
   * Output token ceiling for a single supervisor evaluation call.
   *
   * The 'deep' tier routes to `deepseek-reasoner`, which spends most of its
   * token budget on `reasoning_content` (chain-of-thought) BEFORE it emits the
   * final JSON verdict in `content`. The previous hard-coded 300 was exhausted
   * by the CoT, so the verdict JSON was never produced and the audit row never
   * landed. The reasoner's CoT for this short verdict prompt is typically a few
   * hundred to ~2k tokens, so the total budget needs to comfortably exceed that
   * AND leave room for the (~150-token) JSON verdict. Default 4000;
   * env-configurable so it can be tuned without a redeploy.
   */
  private readonly evalMaxTokens: number;

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
    private readonly verdictAudit: VerdictAuditService,
    private readonly interventionTracker: InterventionTrackerService,
    private readonly adaptiveSampler: AdaptiveSamplerService,
    private readonly config: ConfigService,

    @Optional()
    @Inject(ATTRACTOR_MONITOR_SERVICE)
    private readonly attractorMonitor: AttractorMonitorService | null,
  ) {
    this.enabled =
      this.config.get<string>('SUPERVISOR_ENABLED', 'true') === 'true';

    // Output ceiling for the reasoner evaluation call. Default 4000 leaves room
    // for the reasoner's chain-of-thought PLUS the final JSON verdict (300 did
    // not — the CoT alone exhausted it, so no verdict / no audit row).
    this.evalMaxTokens = parseInt(
      this.config.get<string>('SUPERVISOR_EVAL_MAX_TOKENS', '4000'),
      10,
    );

    const sampleRate = parseInt(
      this.config.get<string>('SUPERVISOR_SAMPLING_RATE', '10'),
      10,
    );

    const adaptive =
      this.config.get<string>('SUPERVISOR_ADAPTIVE_SAMPLING', 'true') !== 'false';

    this.samplingPolicy = {
      sampleRate,
      alwaysEvaluate: ['guardian_feedback', 'attractor_alert'],
      burstMode: false,
      dailyBudgetUsd: parseFloat(
        this.config.get<string>('SUPERVISOR_DAILY_BUDGET_USD', '5.00'),
      ),
      adaptive,
      // Bounded: at most 1-in-2 (most frequent), at least 1-in-60 (least frequent).
      adaptiveMinRate: parseInt(
        this.config.get<string>('SUPERVISOR_ADAPTIVE_MIN_RATE', '2'),
        10,
      ),
      adaptiveMaxRate: parseInt(
        this.config.get<string>('SUPERVISOR_ADAPTIVE_MAX_RATE', '60'),
        10,
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

    // Sampling gate (also resolves WHY this cycle was/wasn't picked, for audit).
    const reason = await this.evaluationReason(cycle);
    if (reason === null) return;

    // Build narration (also folds this cycle into the behavioral baseline).
    const narration = this.narrationBuilder.buildNarration(cycle);

    // Budget gate — pre-flight affordability, not just "any budget left".
    // A single expensive call must not overshoot the daily ceiling.
    const estTokens = this.estimateNarrationTokens(narration);
    const estCost = this.costTracker.estimateCost(estTokens.input, estTokens.output);
    if (!this.costTracker.canAfford(estCost)) {
      vlog('skipping evaluation — estimated cost would breach daily budget', {
        estCost: estCost.toFixed(6),
        remaining: this.costTracker.budgetRemaining().toFixed(6),
      });
      return;
    }

    // Call DeepSeek
    const verdict = await this.evaluate(narration);
    if (!verdict) return;

    // Persist to the auditable trail (CANON Std-2 — truthful LLM_GENERATED
    // provenance). Fire-and-forget buffered write; never blocks.
    this.verdictAudit.record({
      verdict,
      provenance: 'LLM_GENERATED',
      model: this.model,
      evaluationReason: reason,
    });

    // Buffer the verdict (in-memory status view)
    this.recentVerdicts.push(verdict);
    if (this.recentVerdicts.length > VERDICT_BUFFER_SIZE) {
      this.recentVerdicts.shift();
    }

    // A flagged verdict with a suggested correction becomes a tracked,
    // supervisor-sourced intervention (proposed → … lifecycle). The cycle is
    // threaded through so its assembled global input vector can be attached —
    // reinforce/correct REQUIRE it and otherwise skip honestly.
    this.maybeRaiseIntervention(verdict, cycle);

    // Emit for downstream consumers (broadcast service, etc.)
    this.verdictSubject.next(verdict);

    vlog('supervisor verdict', {
      cycleId: verdict.cycleId,
      rating: verdict.rating,
      confidence: verdict.confidence,
      flagged: verdict.flagForGuardian,
      reason,
      costUsd: verdict.costUsd.toFixed(6),
    });
  }

  /**
   * Resolve why (if at all) this cycle should be evaluated.
   *
   * Returns the EvaluationReason when the cycle is selected, or null when it is
   * skipped. Carrying the reason (rather than a bare boolean) lets the audit
   * trail record WHY each verdict was produced — burst, guardian_feedback,
   * attractor_alert, or routine sampling.
   */
  private async evaluationReason(
    cycle: CycleResponse,
  ): Promise<EvaluationReason | null> {
    if (!this.enabled) return null;
    if (this.samplingPolicy.burstMode) return 'burst';

    // Always-evaluate #1: GUARDIAN_FEEDBACK cycles bypass sampling regardless of
    // rate — a guardian correction must never be missed.
    if (
      cycle.inputCategory === 'GUARDIAN_FEEDBACK' &&
      this.samplingPolicy.alwaysEvaluate.includes('guardian_feedback')
    ) {
      return 'guardian_feedback';
    }

    // Always-evaluate #2 (§2.6 attractor_alert half): if any CANON attractor
    // detector is currently active, this cycle is a safety-critical moment and
    // MUST be evaluated, never dropped by sampling. Resolved by querying the
    // attractor monitor live (no shared-type change needed) rather than reading
    // a per-cycle marker off CycleResponse.
    if (
      this.samplingPolicy.alwaysEvaluate.includes('attractor_alert') &&
      (await this.isAttractorActive())
    ) {
      return 'attractor_alert';
    }

    // Adaptive sampling: effective interval derived from budget / novelty / load.
    const effectiveRate = this.adaptiveSampler.nextEffectiveRate(
      this.samplingPolicy,
      {
        budgetUsedFraction: this.costTracker.budgetUsedFraction(),
        arbitrationType: cycle.arbitrationType,
        nowMs: Date.now(),
      },
    );

    return this.cycleCount % effectiveRate === 0 ? 'sampled' : null;
  }

  /**
   * Whether any attractor detector is currently triggered.
   *
   * The attractor monitor is @Optional — when it is absent (tests, minimal
   * wiring) this returns false and the always-evaluate bypass simply doesn't
   * fire (graceful degradation, not a crash). Detector failures are swallowed:
   * a monitor error must never break the supervisor's async path.
   */
  private async isAttractorActive(): Promise<boolean> {
    if (!this.attractorMonitor) return false;
    try {
      const active = await this.attractorMonitor.getActiveAlerts();
      return active.length > 0;
    } catch (err) {
      this.logger.warn(
        `Attractor check failed: ${(err as Error).message}`,
      );
      return false;
    }
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
        maxTokens: this.evalMaxTokens,
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

      // Capture the model that produced this verdict for audit provenance.
      if (response.model) {
        this.model = response.model;
      }

      // Parse response — LlmResponse uses 'content' not 'text'
      const parsed = this.parseVerdict(response.content, narration.cycleId);
      if (!parsed) return null;

      return {
        ...parsed,
        // DeepSeek-reasoner returns chain-of-thought separately from the final
        // verdict; OllamaLlmService now surfaces it as response.reasoningContent.
        // Captured here for the supervisor audit trail.
        reasoningTrace: response.reasoningContent,
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
   * Rough pre-flight token estimate for a narration evaluation call.
   *
   * Used by canAfford() to bound budget overshoot. Uses a ~4-chars-per-token
   * heuristic over the serialized narration + system prompt, and the configured
   * output ceiling (maxTokens). Deliberately conservative (rounds up) so the
   * gate errs toward NOT overspending.
   */
  private estimateNarrationTokens(narration: DecisionNarration): {
    input: number;
    output: number;
  } {
    const serialized = JSON.stringify(narration);
    const inputChars = serialized.length + SUPERVISOR_SYSTEM_PROMPT.length;
    const input = Math.ceil(inputChars / 4);
    const output = this.evalMaxTokens; // matches maxTokens in evaluate()
    return { input, output };
  }

  /**
   * If a verdict flags a problem and carries a concrete suggested correction,
   * record it as a supervisor-sourced intervention in the lifecycle tracker
   * (phase: proposed). This does NOT auto-apply it — auto-application stays a
   * separate, guarded decision; here we only make the proposal auditable.
   */
  private maybeRaiseIntervention(
    verdict: SupervisorVerdict,
    cycle: CycleResponse,
  ): void {
    const correction = verdict.suggestedCorrection;
    if (!verdict.flagForGuardian || !correction) return;

    const intervention: SupervisorIntervention = {
      type: correction.type,
      source: 'supervisor',
      timestamp: new Date(),
      cycleId: verdict.cycleId,
      correctionData: correction,
      // Thread the cycle's exact assembled 1561-dim global input vector so the
      // sidecar's reinforce/correct endpoints can fire for real. Copied through
      // byte-for-byte from CycleResponse (never reconstructed). When the cycle
      // carried no vector (sidecar unavailable / non-tensor path) this is
      // undefined and reinforce/correct skip honestly for this cycle.
      ...(cycle.globalInputVector
        ? { inputVector: [...cycle.globalInputVector] }
        : {}),
    };
    this.interventionTracker.proposed(intervention);
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
      // `text` is the reasoner's final `content` (NOT reasoning_content — the
      // adapter separates the chain-of-thought into response.reasoningContent,
      // which is threaded into the audit record by evaluate()). So we extract
      // the verdict JSON from the conclusion only.
      //
      // Hardened extraction: the old greedy /\{[\s\S]*\}/ could span from the
      // first '{' anywhere in the text to the last '}', swallowing stray prose
      // (or, if content ever leaked CoT, brace-bearing reasoning) into an
      // unparseable blob. Instead, find the LAST well-formed, balanced JSON
      // object in the content — reasoners conventionally put the final answer
      // last — by scanning candidate closing braces from the end.
      const parsed = this.extractFinalJsonObject(text);
      if (!parsed) {
        this.logger.warn('Supervisor response contained no JSON object');
        return null;
      }

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

  /**
   * Robustly extract the final balanced JSON object from a reasoner's final
   * `content`. Returns the parsed object, or null when none parses.
   *
   * Strategy: strip ```json fences if present, then for each '}' encountered
   * from the END of the string, walk backward to its matching '{' (tracking
   * brace depth and skipping braces inside string literals) and attempt a
   * JSON.parse of that slice. The first slice that parses to an object wins.
   * Scanning from the end means that when the model emits multiple objects
   * (e.g. a worked example followed by the real verdict) we take the LAST one —
   * the conclusion — not the first.
   */
  // Returns `any` (like the JSON.parse it replaces): parseVerdict already
  // validates/coerces every field defensively (rating whitelist, clamp,
  // String()/Boolean()), so the loose type is consumed safely there.
  private extractFinalJsonObject(text: string): any {
    if (!text) return null;

    // Drop code-fence markers so the brace scan sees raw JSON.
    const cleaned = text.replace(/```(?:json)?/gi, '');

    for (let end = cleaned.length - 1; end >= 0; end--) {
      if (cleaned[end] !== '}') continue;

      let depth = 0;
      let inString = false;

      for (let start = end; start >= 0; start--) {
        const ch = cleaned[start];

        if (inString) {
          // Walking backward: a quote toggles string state UNLESS it is escaped.
          // An escape is a backslash immediately BEFORE this char (start-1).
          if (ch === '"' && cleaned[start - 1] !== '\\') {
            inString = false;
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
          continue;
        }

        if (ch === '}') depth++;
        else if (ch === '{') {
          depth--;
          if (depth === 0) {
            const candidate = cleaned.slice(start, end + 1);
            try {
              const obj = JSON.parse(candidate);
              if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                return obj;
              }
            } catch {
              // Not valid JSON at this boundary — keep scanning earlier '}'.
            }
            break; // matched this '}' (parse failed) → try the next '}' leftward
          }
        }
      }
    }

    return null;
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
      effectiveSampleRate:
        this.adaptiveSampler.getLastEffectiveRate() || this.samplingPolicy.sampleRate,
      recentInterventions: this.interventionTracker.getRecent(20),
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

    // Open the lifecycle record (proposed → applied/rejected) so the
    // intervention is auditable end-to-end, not a fire-and-forget side effect.
    const interventionId = this.interventionTracker.proposed(intervention);

    // Forward to cognition-service sidecar control channel
    this.sidecarControl
      .executeIntervention(intervention)
      .then((result) => {
        if (result.accepted) {
          this.interventionTracker.applied(interventionId);
        } else {
          this.interventionTracker.rejected(
            interventionId,
            result.error ?? 'sidecar rejected',
          );
          this.logger.warn(
            `Sidecar rejected intervention ${intervention.type}: ${result.error}`,
          );
        }
      })
      .catch((err) => {
        this.interventionTracker.rejected(
          interventionId,
          (err as Error).message,
        );
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
