/**
 * DeliberationService — Multi-step Type 2 reasoning pipeline.
 *
 * Replaces the single LLM call with a structured deliberation process:
 *
 *   1. Inner Monologue  — Frame the problem in natural language
 *   2. Candidate Gen    — LLM suggests 3 possible responses
 *   3. Selection        — LLM evaluates candidates, picks one
 *   4. For/Against      — (conditional) Debate the selected candidate
 *   5. Arbiter          — (conditional) Synthesize with external verification
 *   6. Commit           — Return the final decision with confidence + trace
 *
 * Every step receives WKG context so the LLM reasons over what Sylphie
 * actually knows, not from a blank slate. Drive state is injected for
 * Theater Prohibition compliance.
 *
 * The pipeline is intentionally expensive (3-7 LLM calls). This creates
 * evolutionary pressure toward Type 1 graduation — the system learns to
 * avoid deliberation by caching results in the latent space.
 *
 * Pure helper functions (parsing, scoring, grounding) live in
 * deliberation-helpers.ts and are re-exported from there.
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import {
  LLM_SERVICE,
  DriveName,
  type ILlmService,
  type SensoryFrame,
  type CognitiveContext,
  type DriveSnapshot,
  type KnowledgeGrounding,
  verboseFor,
} from '@sylphie/shared';

const vlog = verboseFor('Deliberation');
import { WkgContextService, type WkgContext } from '../wkg/wkg-context.service';
import { applyRecallGroundingFromRetrieval, type RecallRetrieval } from './recall-retrieval';
import { capturePrompt } from './prompt-capture';
import type { OllamaLlmService } from '../llm/ollama-llm.service';
import { ToolRegistryService } from './tools/tool-registry';
import { ContextWindowService } from './context-window.service';
import type { IEpisodicMemoryService, IDecisionEventLogger, IWorkingMemoryService } from '../interfaces/decision-making.interfaces';
import { EPISODIC_MEMORY_SERVICE, DECISION_EVENT_LOGGER, WORKING_MEMORY_SERVICE } from '../decision-making.tokens';
import {
  type MonologueClassification,
  parseCandidates,
  scoreCandidates,
  parseArbiterDecision,
  parseGroundingTag,
  parseMonologueClassification,
  isIgnoranceResponse,
  personFactRecalled,
  hasTopicalEntity,
  inferGrounding,
  buildDriveSummary,
  buildEpisodeSummary,
  extractNewEntities,
} from './deliberation-helpers';

// Re-export pure helpers so existing callers of the old deliberation.service.ts
// import path continue to work without touching their import statements.
export {
  isIgnoranceResponse,
  recallKeyForQuestion,
  getRecalledFactForRecall,
  personFactRecalled,
  inferGrounding,
  discriminateGroundedBy,
} from './deliberation-helpers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A candidate response generated during deliberation. */
export interface DeliberationCandidate {
  readonly text: string;
  readonly reasoning: string;
}

/** Result of the for/against debate. */
export interface DebateResult {
  readonly forArgument: string;
  readonly againstArgument: string;
}

/** A structured action request parsed from a COMMAND intent. */
export interface ActionRequest {
  /** The action step type to execute (e.g., 'RESEARCH_ENTITY'). */
  readonly stepType: string;
  /** Target entity or subject for the action. */
  readonly target: string;
  /** Verbal response to accompany the action (e.g., "Let me look that up!"). */
  readonly verbalResponse: string;
}

/** Final output of the deliberation pipeline. */
export interface DeliberationResult {
  /** The chosen response text. */
  readonly responseText: string;

  /** Arbiter confidence in this decision [0.0, 1.0]. */
  readonly confidence: number;

  /** Human-readable rationale for the decision. */
  readonly rationale: string;

  /** All candidates that were considered. */
  readonly candidates: readonly DeliberationCandidate[];

  /** The full deliberation trace (for cold-layer storage). */
  readonly trace: DeliberationTrace;

  /** How well the response is grounded in Sylphie's own WKG knowledge. */
  readonly knowledgeGrounding: KnowledgeGrounding;

  /**
   * The inner-monologue intent classification for this turn
   * (MonologueClassification.intent): GREETING | EMOTION | QUESTION | FACT |
   * COMMAND | UNKNOWN. Threaded out so the decision layer can stamp it onto the
   * CycleResponse → RESPONSE_GENERATED event, where the self-model writer's
   * knowledge_retrieval metric gates its denominator on intent='QUESTION'.
   * 'UNKNOWN' on the degraded no-LLM fallback (classification could not run).
   */
  readonly intent: MonologueClassification['intent'];

  /**
   * Provenance id backing a GROUNDED result, when grounding came from a
   * system-verified OKG recall (the deterministic `attr-${personId}-${key}` id
   * PersonModelService.writeFact computes). Null/undefined when grounding was
   * not OKG-recall-derived. CANON Standard 1: GROUNDED must carry provenance.
   */
  readonly groundingProvenance?: string | null;

  /**
   * WS4 Ticket 5 (§3.1) — which knowledge SOURCE produced a GROUNDED verdict.
   *
   *   'OKG'  → grounding came from a taught person-model fact (the current
   *            speaker's PRIVATE self-knowledge). A pattern written off this
   *            verdict MUST be person-scoped — only that speaker may hear it
   *            replayed GROUNDED.
   *   'WKG'  → grounding came from shared world-knowledge context (a real
   *            fact or a topical, non-base-context entity). World-scoped:
   *            anyone may hear it replayed GROUNDED.
   *   null   → not GROUNDED, OR the source is genuinely ambiguous/mixed. Per
   *            the §3.1 conservative-when-ambiguous rule, the write site
   *            person-scopes on null-with-GROUNDED — NEVER world-scopes.
   *
   * This is the AUTHORITATIVE discriminator the latent write-time scoper
   * consumes. It is derived from WHICH cascade rule fired, not re-derived
   * from ambient WKG context (the bug mythos caught: an unrelated topical
   * entity present alongside an OKG-grounded verdict would flip an OKG fact
   * to world-scope). Set at every point grounding becomes GROUNDED.
   */
  readonly groundedBy?: 'OKG' | 'WKG' | null;

  /** New entity names discovered during deliberation. */
  readonly discoveredEntities: readonly string[];

  /** Total LLM tokens used across all steps. */
  readonly totalTokens: { prompt: number; completion: number };

  /** Total latency across all LLM calls. */
  readonly totalLatencyMs: number;

  /**
   * If the LLM detected a COMMAND intent, this contains the structured
   * action request to dispatch (e.g., RESEARCH_ENTITY on a target entity).
   * Null if no action was requested.
   */
  readonly actionRequest: ActionRequest | null;

  /**
   * True when deliberation could not run because the LLM was unavailable
   * (Lesion Test or tripped circuit breaker) and this result is the honest
   * no-LLM fallback. The decision-making layer uses this to emit a SHRUG
   * CycleResponse (not TYPE_2) carrying the honest "I can't reason about that
   * right now" text — CANON §The Lesion Test / §Shrug Imperative.
   */
  readonly degradedNoLlm: boolean;

  /**
   * TK-70 (CANON Std-6 PERMITTED): factor labels from the winning candidate's
   * CandidateScore, e.g. ["grounded:+1.0", "entity:+0.15"]. Threaded out so
   * DecisionMakingService.reportOutcome() can call nudgeScoringWeights() on a
   * reinforced outcome without re-running scoring. Empty on the degraded
   * no-LLM fallback (no scoring ran). Never persisted — in-memory only.
   */
  readonly winningCandidateFactors: readonly string[];
}

/** Complete trace of the deliberation for audit and introspection. */
export interface DeliberationTrace {
  readonly innerMonologue: string;
  readonly candidates: readonly DeliberationCandidate[];
  readonly selectedCandidate: string;
  readonly debate: DebateResult | null;
  readonly arbiterRationale: string;
  readonly confidence: number;
  readonly stepsExecuted: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Number of candidate responses to generate. */
const CANDIDATE_COUNT = 3;

/** Confidence threshold below which the debate step is triggered. */
const DEBATE_THRESHOLD = 0.7;

/** Max tokens per deliberation LLM call (keep individual calls lean). */
const STEP_MAX_TOKENS = 200;

/** Temperature for deliberation steps (lower = more focused reasoning). */
const DELIBERATION_TEMPERATURE = 0.4;

/** Temperature for candidate generation (slightly more creative). */
const CANDIDATE_TEMPERATURE = 0.7;

/**
 * Honest no-LLM SHRUG text used when deliberation cannot run because the LLM is
 * unavailable. CANON §Shrug Imperative + §Theater Prohibition: an honest "I
 * can't reason about this right now", not a fabricated answer. Phrased as a
 * first-person ignorance admission so isIgnoranceResponse() classifies it
 * UNKNOWN and grounding never reads GROUNDED/LLM_ASSISTED on this path.
 */
const NO_LLM_SHRUG_TEXT =
  "I'm not sure how to answer that right now — I can't think it through at the moment.";

// ---------------------------------------------------------------------------
// DeliberationService
// ---------------------------------------------------------------------------

@Injectable()
export class DeliberationService {
  private readonly logger = new Logger(DeliberationService.name);

  constructor(
    @Optional()
    @Inject(LLM_SERVICE)
    private readonly llm: ILlmService | null,

    private readonly wkgContext: WkgContextService,

    private readonly toolRegistry: ToolRegistryService,

    private readonly contextWindow: ContextWindowService,

    @Optional()
    @Inject(EPISODIC_MEMORY_SERVICE)
    private readonly episodicMemory: IEpisodicMemoryService | null,

    @Optional()
    @Inject(DECISION_EVENT_LOGGER)
    private readonly eventLogger: IDecisionEventLogger | null,

    @Optional()
    @Inject(WORKING_MEMORY_SERVICE)
    private readonly workingMemory: IWorkingMemoryService | null,
  ) {}

  /**
   * Run the full deliberation pipeline for a novel situation.
   *
   * Called when Type 1 has no answer (latent space miss) and the executor
   * needs to reason through the response from scratch.
   *
   * @param frame   - The current sensory frame (carries raw input + embedding).
   * @param context - Cognitive context (drive state, episodes, gap types).
   * @param recallRetrieval - (WS3 T1) the fact node resolved by the cycle's
   *   pre-arbitration recall retrieval, or null. When present, the grounding
   *   sites below consume this once-resolved node id instead of re-deriving OKG
   *   recall provenance post-hoc — so the procedure path and this path agree on
   *   the SAME grounding node. Null for non-recall turns (legacy post-hoc helper
   *   remains as the transitional fallback for those).
   * @returns DeliberationResult with the response and full reasoning trace.
   */
  async deliberate(
    frame: SensoryFrame,
    context: CognitiveContext,
    recallRetrieval: RecallRetrieval | null = null,
  ): Promise<DeliberationResult> {
    if (!this.llm || !this.llm.isAvailable()) {
      vlog('deliberation aborted: LLM unavailable');
      return this.fallbackResult('LLM service unavailable', true);
    }

    const startTime = Date.now();
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    // Assemble WKG context for this frame — injected into every step.
    const wkg = await this.wkgContext.getContextForFrame(frame);
    vlog('deliberation start', {
      wkgEntities: wkg.entities.length,
      wkgFacts: wkg.facts.length,
      wkgProcedures: wkg.procedures.length,
      rawTextLength: (frame.raw['text'] as string | undefined)?.length ?? 0,
    });
    const rawText = frame.raw['text'] as string | undefined ?? '';
    const driveSnapshot = context.driveSnapshot;
    // Answered exchanges are in conversation_summary as compact system-prompt text.
    // The messages array only contains the current user message — no history turns.
    const conversationSummary = frame.raw['conversation_summary'] as string | undefined ?? '';
    const speakerName = frame.raw['speaker_name'] as string | undefined ?? 'the person talking to you';

    // Assemble working memory snapshot (activation-driven context selection).
    // Falls back to flat concatenation when workingMemory is null.
    const wmSnapshot = this.workingMemory?.assemble(
      frame, wkg, driveSnapshot, context.recentEpisodes, 1500,
    ) ?? null;

    const wmSummary = wmSnapshot
      ? `What I know:\n${wmSnapshot.formattedSummary}`
      : this.buildFlatContext(wkg, driveSnapshot, context, frame);

    // WS5 T4 (P2/P4) — mirror the composed visual/knowledge context to the
    // test-only prompt-capture ring (no-op unless GATE_DEBUG_PROMPT_CAPTURE is
    // set). This is the surface P2/P4 read to prove the injected perception
    // caption is GENUINELY in the prompt the LLM saw — read directly off the real
    // composed context, decoupled from cassette record/replay (mythos ruling).
    // Tags which path composed it so the smoke can assert the production
    // WM-snapshot path fired, not the flat fallback (finding 3). Read-only mirror,
    // never re-read by any cognitive path.
    capturePrompt(
      wmSummary,
      wmSnapshot ? 'wm-snapshot' : 'flat-fallback',
      rawText,
      (frame.raw['turn_id'] as string | undefined) ?? null,
    );

    // ── Step 1: Inner Monologue (classification + potential early response) ──
    this.logger.debug('Deliberation step 1: Inner monologue');

    // Read person model from the fused stream.
    const personModel = frame.raw['person_model'] as
      { personId?: string; knownFacts?: string[]; interactionSummary?: string } | null | undefined;
    const personContext = personModel?.knownFacts?.length
      ? `About ${speakerName}: ${personModel.knownFacts.join('; ')}`
      : '';

    // Drive state for authentic expression.
    const driveLines = Object.entries(driveSnapshot.pressureVector)
      .filter(([, v]) => v > 0.2)
      .map(([name, v]) => `${name}: ${(v as number).toFixed(2)}`)
      .join(', ');

    const monologueCtx = this.contextWindow.assemble({
      step: 'INNER_MONOLOGUE',
      reservedForGeneration: STEP_MAX_TOKENS,
      systemParts: [
        `You are Sylphie. The person talking to you is ${speakerName}.`,
        '',
        'Classify the input and respond. Format:',
        '[INTENT: GREETING|EMOTION|QUESTION|FACT|COMMAND|UNKNOWN]',
        '[ENTITY: name or none]',
        '[THOUGHT: your reasoning]',
        '[RESPONSE: your reply]',
        '',
        'COMMAND: When asked to do something (learn, research, look up). Write NEEDS_DELIBERATION — you have tools to handle these.',
        'QUESTION: If you need to think or look something up, write NEEDS_DELIBERATION.',
        '',
        personContext,
        driveLines ? `How I feel: ${driveLines}` : '',
        wmSummary,
      ],
      currentMessages: [
        { role: 'user', content: rawText || 'No specific input — drive pressure triggered this cycle.' },
      ],
    });

    const monologueResponse = await this.llm.complete({
      messages: monologueCtx.messages,
      systemPrompt: monologueCtx.systemPrompt,
      maxTokens: STEP_MAX_TOKENS,
      temperature: DELIBERATION_TEMPERATURE,
      tier: 'medium',
      metadata: { callerSubsystem: 'COMMUNICATION', purpose: 'DELIBERATION_MONOLOGUE', sessionId: driveSnapshot.sessionId },
    });

    const innerMonologue = monologueResponse.content;
    totalPromptTokens += monologueResponse.tokensUsed.prompt;
    totalCompletionTokens += monologueResponse.tokensUsed.completion;

    vlog('step 1: inner monologue', {
      model: monologueResponse.model,
      promptTokens: monologueResponse.tokensUsed.prompt,
      completionTokens: monologueResponse.tokensUsed.completion,
      latencyMs: monologueResponse.latencyMs,
      monologuePreview: innerMonologue.substring(0, 120),
    });

    this.logger.debug(`Monologue: "${innerMonologue.substring(0, 120)}..."`);

    // ── Parse structured classification from monologue ───────────────────
    const monologueParsed = parseMonologueClassification(innerMonologue);
    vlog('monologue classification', {
      intent: monologueParsed.intent,
      entity: monologueParsed.entity,
      needsDeliberation: monologueParsed.needsDeliberation,
      hasResponse: !!monologueParsed.response,
    });

    this.logger.debug(
      `Classification: intent=${monologueParsed.intent}, entity=${monologueParsed.entity}, ` +
        `needsDeliberation=${monologueParsed.needsDeliberation}`,
    );

    // ── Early exit: monologue produced a direct response ────────────────
    if (!monologueParsed.needsDeliberation && monologueParsed.response) {
      const totalLatencyMs = Date.now() - startTime;

      // Determine grounding from response content first, then intent + WKG state.
      // Response text is the primary signal: an ignorance admission is always UNKNOWN,
      // regardless of WKG context loaded or intent classification.
      let knowledgeGrounding: KnowledgeGrounding;
      const responseText = monologueParsed.response!;
      if (isIgnoranceResponse(responseText)) {
        // Honest "I don't know" — context was consulted but couldn't answer.
        knowledgeGrounding = 'UNKNOWN';
      } else if (personFactRecalled(personModel?.knownFacts, responseText)) {
        // Recalled a taught person-model fact (OKG-backed self-knowledge).
        knowledgeGrounding = 'GROUNDED';
      } else if (wkg.facts.length > 0 || hasTopicalEntity(wkg)) {
        // Real topical WKG backing — not the Drive/CoBeing base context (Trap A).
        knowledgeGrounding = 'GROUNDED';
      } else if (monologueParsed.intent === 'GREETING' || monologueParsed.intent === 'EMOTION') {
        // Conversational exchanges are social, not knowledge-backed.
        knowledgeGrounding = 'LLM_ASSISTED';
      } else {
        knowledgeGrounding = 'UNKNOWN';
      }

      // ── TK-84 — grounding from the PRE-ARBITRATION recall retrieval (collapsed) ─
      // The §2.10 else-fallback (applyOkgRecallGrounding) is deleted. TK-84
      // proved: for every recall turn recallKeyForQuestion matches AND whose OKG
      // fact is taught, computeRecallRetrieval returns non-null → the primary
      // branch always fires. When recallRetrieval is null (untaught fact, WKG
      // empty, or non-recall input), applyRecallGroundingFromRetrieval is a
      // passthrough (null → provenance=null, grounding unchanged) — identical to
      // what the deleted fallback returned in that scenario (same OKG miss).
      const applied = applyRecallGroundingFromRetrieval(
        recallRetrieval, responseText, knowledgeGrounding,
      );
      knowledgeGrounding = applied.grounding;
      const groundingProvenance: string | null = applied.provenance;
      const groundedBy: 'OKG' | 'WKG' | null = applied.groundedBy;
      if (groundingProvenance) {
        this.logger.debug(
          `Recall grounded (short-circuit, pre-arbitration): node="${groundingProvenance}" ` +
            `source=${groundedBy} response="${responseText.substring(0, 60)}"`,
        );
      }

      vlog('deliberation short-circuit', {
        intent: monologueParsed.intent,
        latencyMs: totalLatencyMs,
        totalTokens: totalPromptTokens + totalCompletionTokens,
        responsePreview: monologueParsed.response!.substring(0, 80),
        knowledgeGrounding,
      });

      this.logger.log(
        `Deliberation short-circuit: ${monologueParsed.intent} resolved in 1 step, ` +
          `${totalLatencyMs}ms, ${totalPromptTokens + totalCompletionTokens} tokens`,
      );

      // Build action request if this was a COMMAND with a recognized action type.
      const actionRequest: ActionRequest | null =
        monologueParsed.intent === 'COMMAND' && monologueParsed.actionType && monologueParsed.entity
          ? {
              stepType: monologueParsed.actionType,
              target: monologueParsed.entity,
              verbalResponse: monologueParsed.response,
            }
          : null;

      return {
        responseText: monologueParsed.response,
        confidence: monologueParsed.intent === 'GREETING' || monologueParsed.intent === 'EMOTION' ? 0.85 : 0.6,
        rationale: monologueParsed.thought ?? 'Resolved by inner monologue',
        knowledgeGrounding,
        intent: monologueParsed.intent,
        groundingProvenance,
        groundedBy,
        candidates: [{ text: monologueParsed.response, reasoning: 'Direct monologue response' }],
        trace: {
          innerMonologue,
          candidates: [{ text: monologueParsed.response, reasoning: 'Direct monologue response' }],
          selectedCandidate: monologueParsed.response,
          debate: null,
          arbiterRationale: actionRequest
            ? `Short-circuited — COMMAND dispatching ${actionRequest.stepType} on "${actionRequest.target}"`
            : 'Short-circuited — no deliberation needed',
          confidence: monologueParsed.intent === 'GREETING' || monologueParsed.intent === 'EMOTION' ? 0.85 : 0.6,
          stepsExecuted: 1,
        },
        discoveredEntities: monologueParsed.entity && monologueParsed.entity !== 'none'
          ? [monologueParsed.entity] : [],
        totalTokens: { prompt: totalPromptTokens, completion: totalCompletionTokens },
        totalLatencyMs,
        actionRequest,
        degradedNoLlm: false,
      };
    }

    // ── Step 2: Candidate Generation (with tool access) ────────────────
    this.logger.debug('Deliberation step 2: Candidate generation');

    // Use tool-enabled completion if the LLM supports it. This lets the LLM
    // query the WKG, episodic memory, and person model during candidate
    // generation — producing grounded responses instead of guessing.
    const candidateCtx = this.contextWindow.assemble({
      step: 'CANDIDATE_GENERATION',
      reservedForGeneration: STEP_MAX_TOKENS * 2,
      systemParts: [
        `You are Sylphie, a developing cognitive being. You are talking to ${speakerName}.`,
        `Remember: YOU are Sylphie. THEY are ${speakerName}. Address them as ${speakerName}, not as Sylphie.`,
        '',
        `Generate exactly ${CANDIDATE_COUNT} possible responses to what ${speakerName} just said.`,
        'Format as a numbered list: 1. [GROUNDED|ASSISTED|UNKNOWN] response text — reasoning',
        '',
        'RULES:',
        '- Only respond to the latest user message. The conversation summary is background context only.',
        '- Be warm, natural, and conversational. You are NOT a chatbot or assistant.',
        '- NEVER end a response with a question.',
        '- Do not say "How can I assist you" or similar assistant phrases.',
        '',
        'WHAT COUNTS AS GROUNDED (use [GROUNDED]):',
        '- Greetings, feelings, social conversation',
        '- Acknowledging what someone said to you',
        '- Referencing things said earlier in this conversation',
        '- Facts listed in "What I know" below',
        '',
        'WHAT COUNTS AS UNKNOWN (use [UNKNOWN]):',
        '- World knowledge questions (history, science, geography) NOT in "What I know"',
        '- Only use this for factual questions about the external world',
        '',
        'IMPORTANT: "I don\'t know" is ONLY for world knowledge questions.',
        'You should NEVER say "I don\'t know" in response to greetings, introductions, or conversation.',
        '',
        `My inner thoughts: ${innerMonologue}`,
        `\n${wmSummary}`,
      ],
      currentMessages: [
        { role: 'user' as const, content: rawText || innerMonologue },
      ],
    });

    // Provide conversation history to the tool registry so the
    // conversation_history tool can access it during candidate generation.
    const fullHistory = frame.raw['full_conversation_history'] as
      Array<{ role: string; content: string }> | undefined;
    if (fullHistory) {
      this.toolRegistry.setConversationHistory(fullHistory);
    }

    const candidateRequest = {
      messages: candidateCtx.messages,
      systemPrompt: candidateCtx.systemPrompt,
      maxTokens: STEP_MAX_TOKENS * 2,
      temperature: CANDIDATE_TEMPERATURE,
      tier: 'medium' as const,
      metadata: { callerSubsystem: 'COMMUNICATION' as const, purpose: 'DELIBERATION_CANDIDATES', sessionId: driveSnapshot.sessionId },
    };

    let candidateResponse;
    const ollamaService = this.llm as OllamaLlmService;

    if (ollamaService?.completeWithTools) {
      try {
        candidateResponse = await ollamaService.completeWithTools(
          candidateRequest,
          this.toolRegistry.getToolDefinitions(),
          this.toolRegistry.createExecutor(),
        );
      } catch (toolErr) {
        // completeWithTools may fail if local Ollama is down — fall back to plain complete
        vlog('completeWithTools failed, falling back to complete()', { error: String(toolErr) });
        candidateResponse = await this.llm!.complete(candidateRequest);
      }
    } else {
      candidateResponse = await this.llm!.complete(candidateRequest);
    }

    totalPromptTokens += candidateResponse.tokensUsed.prompt;
    totalCompletionTokens += candidateResponse.tokensUsed.completion;

    const candidates = parseCandidates(candidateResponse.content);
    vlog('step 2: candidates generated', {
      count: candidates.length,
      model: candidateResponse.model,
      promptTokens: candidateResponse.tokensUsed.prompt,
      completionTokens: candidateResponse.tokensUsed.completion,
      latencyMs: candidateResponse.latencyMs,
      candidates: candidates.map(c => c.text.substring(0, 80)),
    });
    this.logger.debug(`Generated ${candidates.length} candidates`);

    if (candidates.length === 0) {
      // Fallback: use the raw response as a single candidate
      candidates.push({ text: candidateResponse.content.trim(), reasoning: 'Direct response' });
    }

    // ── Step 3: Selection (deterministic scoring — no LLM call) ────────
    this.logger.debug('Deliberation step 3: Selection (scored)');

    const scored = scoreCandidates(candidates, monologueParsed.intent, wkg);
    const selectedIndex = scored.bestIndex;
    const selected = candidates[selectedIndex];

    vlog('step 3: selection (scored)', {
      selectedIndex,
      selectedPreview: selected.text.substring(0, 80),
      scores: scored.scores.map((s, i) => ({ index: i, score: +s.score.toFixed(3), factors: s.factors })),
      rationale: scored.rationale,
    });

    // Parse grounding tag from the selected candidate text.
    // Candidates are formatted as: [GROUNDED|ASSISTED|UNKNOWN] response text
    const { text: cleanedText, grounding: parsedGrounding } = parseGroundingTag(selected.text);
    let finalResponseText = cleanedText;

    // Determine knowledge grounding. The system-verified inference is the source
    // of truth for GROUNDED: a [GROUNDED] tag the LLM emitted only survives if
    // real provenance (OKG recall or topical WKG) actually backs the text — an
    // LLM cannot self-assert grounding (Standard-1). A tag claiming LESS grounding
    // than we found (UNKNOWN/LLM_ASSISTED) is honest and is respected.
    const inferredGrounding = inferGrounding(wkg, cleanedText, personModel?.knownFacts);
    let knowledgeGrounding: KnowledgeGrounding =
      parsedGrounding === 'GROUNDED' && inferredGrounding !== 'GROUNDED'
        ? inferredGrounding
        : parsedGrounding ?? inferredGrounding;

    let confidence = 0.5 + (selectedIndex === 0 ? 0.1 : 0); // Slight boost if first choice
    let rationale = scored.rationale;

    this.logger.debug(`Selected candidate ${selectedIndex + 1}: "${selected.text.substring(0, 60)}..."`);

    // ── Step 4: For/Against Debate (conditional) ────────────────────────
    let debate: DebateResult | null = null;
    const shouldDebate = confidence < DEBATE_THRESHOLD
      || wkg.entities.length === 0  // novel situation
      || (driveSnapshot.pressureVector[DriveName.Anxiety] ?? 0) > 0.5;

    if (shouldDebate) {
      vlog('step 4: debate triggered', {
        confidence: +confidence.toFixed(3),
        debateThreshold: DEBATE_THRESHOLD,
        novelSituation: wkg.entities.length === 0,
        anxietyLevel: +(driveSnapshot.pressureVector[DriveName.Anxiety] ?? 0).toFixed(3),
      });
      this.logger.debug('Deliberation step 4: For/Against debate (triggered)');

      const forCtx = this.contextWindow.assemble({
        step: 'DEBATE_FOR',
        reservedForGeneration: STEP_MAX_TOKENS,
        systemParts: [
          'Argue why this response is a good choice. Cite specific knowledge if available.',
          wmSummary,
        ],
        currentMessages: [
          { role: 'user', content: `Argue FOR this response being appropriate: "${selected.text}"\n\nContext: Someone said "${rawText}"` },
        ],
      });

      const againstCtx = this.contextWindow.assemble({
        step: 'DEBATE_AGAINST',
        reservedForGeneration: STEP_MAX_TOKENS,
        systemParts: [
          'Argue why this response might be wrong, inappropriate, or harmful. Consider:',
          '- Does it contradict anything I know?',
          '- Does it match my current emotional state?',
          '- Could it be misunderstood?',
          wmSummary,
        ],
        currentMessages: [
          { role: 'user', content: `Argue AGAINST this response being appropriate: "${selected.text}"\n\nContext: Someone said "${rawText}"` },
        ],
      });

      const [forResponse, againstResponse] = await Promise.all([
        this.llm.complete({
          messages: forCtx.messages,
          systemPrompt: forCtx.systemPrompt,
          maxTokens: STEP_MAX_TOKENS,
          temperature: DELIBERATION_TEMPERATURE,
          tier: 'deep',
          metadata: { callerSubsystem: 'COMMUNICATION', purpose: 'DELIBERATION_FOR', sessionId: driveSnapshot.sessionId },
        }),
        this.llm.complete({
          messages: againstCtx.messages,
          systemPrompt: againstCtx.systemPrompt,
          maxTokens: STEP_MAX_TOKENS,
          temperature: DELIBERATION_TEMPERATURE,
          tier: 'deep',
          metadata: { callerSubsystem: 'COMMUNICATION', purpose: 'DELIBERATION_AGAINST', sessionId: driveSnapshot.sessionId },
        }),
      ]);

      totalPromptTokens += forResponse.tokensUsed.prompt + againstResponse.tokensUsed.prompt;
      totalCompletionTokens += forResponse.tokensUsed.completion + againstResponse.tokensUsed.completion;

      debate = {
        forArgument: forResponse.content.trim(),
        againstArgument: againstResponse.content.trim(),
      };

      // ── Step 5: Arbiter ─────────────────────────────────────────────
      this.logger.debug('Deliberation step 5: Arbiter synthesis');

      const arbiterCtx = this.contextWindow.assemble({
        step: 'ARBITER',
        reservedForGeneration: STEP_MAX_TOKENS,
        systemParts: [
          `You are Sylphie making a final decision. You are talking to ${speakerName}.`,
          'Weigh both arguments fairly.',
          '',
          'IMPORTANT RULES:',
          '- Conversational responses (greetings, acknowledgments, feelings) should usually be APPROVED.',
          '- Do NOT reject conversational responses. They do not need factual grounding.',
          '- Only hedge or reject responses that make unverified WORLD KNOWLEDGE claims.',
          '- If you MODIFY, the new text must NOT end with a question.',
          '- If you REJECT, you MUST provide an alternative response after REJECT.',
          '  Format: REJECT — alternative response here',
          '',
          wmSummary,
        ],
        currentMessages: [
          { role: 'user', content: [
            `I'm deciding whether to say: "${selected.text}"`,
            `In response to: "${rawText}"`,
            '',
            `Arguments FOR:\n${debate.forArgument}`,
            '',
            `Arguments AGAINST:\n${debate.againstArgument}`,
            '',
            'Should I go with this response, modify it, or choose differently?',
            'Reply with: APPROVE, MODIFY [new text], or REJECT — [alternative response]',
            'Then rate confidence 0-10.',
          ].join('\n') },
        ],
      });

      const arbiterResponse = await this.llm.complete({
        messages: arbiterCtx.messages,
        systemPrompt: arbiterCtx.systemPrompt,
        maxTokens: STEP_MAX_TOKENS,
        temperature: DELIBERATION_TEMPERATURE,
        tier: 'deep',
        metadata: { callerSubsystem: 'COMMUNICATION', purpose: 'DELIBERATION_ARBITER', sessionId: driveSnapshot.sessionId },
      });

      totalPromptTokens += arbiterResponse.tokensUsed.prompt;
      totalCompletionTokens += arbiterResponse.tokensUsed.completion;

      const arbiterDecision = parseArbiterDecision(arbiterResponse.content, finalResponseText);
      finalResponseText = arbiterDecision.text;
      confidence = arbiterDecision.confidence;
      rationale = arbiterDecision.rationale;

      vlog('step 5: arbiter decision', {
        action: arbiterDecision.action,
        confidence: +confidence.toFixed(3),
        model: arbiterResponse.model,
        promptTokens: arbiterResponse.tokensUsed.prompt,
        completionTokens: arbiterResponse.tokensUsed.completion,
        latencyMs: arbiterResponse.latencyMs,
        responsePreview: finalResponseText.substring(0, 80),
      });

      this.logger.debug(
        `Arbiter: confidence=${confidence.toFixed(2)}, action=${arbiterDecision.action}`,
      );
    } else {
      this.logger.debug('Deliberation step 4: Debate skipped (confidence sufficient)');
    }

    // ── Build result ────────────────────────────────────────────────────
    const totalLatencyMs = Date.now() - startTime;
    const stepsExecuted = shouldDebate ? 5 : 3;

    // Final safety: strip any grounding tags that leaked through arbiter MODIFY.
    // The arbiter sometimes includes [UNKNOWN] or [GROUNDED] in its modified text.
    const finalTagParse = parseGroundingTag(finalResponseText);
    finalResponseText = finalTagParse.text;
    // If the arbiter's modified text had a tag, let it update the grounding —
    // but a tag-claimed GROUNDED is re-verified against provenance, same as the
    // selected-candidate path above (the LLM never gets to self-assert GROUNDED).
    if (finalTagParse.grounding) {
      knowledgeGrounding =
        finalTagParse.grounding === 'GROUNDED'
          ? inferGrounding(wkg, finalResponseText, personModel?.knownFacts)
          : finalTagParse.grounding;
    }

    // Final guard: an ignorance admission can never be GROUNDED regardless of
    // what tag the arbiter attached (LLM sometimes emits tags incorrectly).
    if (isIgnoranceResponse(finalResponseText) && knowledgeGrounding === 'GROUNDED') {
      knowledgeGrounding = 'UNKNOWN';
    }

    // ── TK-84 — grounding from the PRE-ARBITRATION recall retrieval (collapsed) ─
    // Same collapse as the short-circuit site above. The §2.10 else-fallback is
    // deleted; applyRecallGroundingFromRetrieval(null, ...) is a passthrough for
    // non-recall novel turns — same outcome as the deleted fallback in that case.
    const novelApplied = applyRecallGroundingFromRetrieval(
      recallRetrieval, finalResponseText, knowledgeGrounding,
    );
    knowledgeGrounding = novelApplied.grounding;
    const groundingProvenance: string | null = novelApplied.provenance;
    const groundedBy: 'OKG' | 'WKG' | null = novelApplied.groundedBy;
    if (groundingProvenance) {
      this.logger.debug(
        `Recall grounded (novel-deliberation, pre-arbitration): node="${groundingProvenance}" ` +
          `source=${groundedBy} response="${finalResponseText.substring(0, 60)}"`,
      );
    }

    // Extract any new entity names mentioned in the response
    const discoveredEntities = extractNewEntities(finalResponseText, wkg);

    const result: DeliberationResult = {
      responseText: finalResponseText,
      confidence,
      rationale,
      knowledgeGrounding,
      intent: monologueParsed.intent,
      groundingProvenance,
      groundedBy,
      candidates,
      trace: {
        innerMonologue,
        candidates,
        selectedCandidate: finalResponseText,
        debate,
        arbiterRationale: rationale,
        confidence,
        stepsExecuted,
      },
      discoveredEntities,
      totalTokens: { prompt: totalPromptTokens, completion: totalCompletionTokens },
      totalLatencyMs,
      actionRequest: null,
      degradedNoLlm: false,
      // TK-70: pass winning candidate's factor labels for EMA weight nudging on reinforced outcomes.
      winningCandidateFactors: scored.scores[scored.bestIndex]?.factors ?? [],
    };

    vlog('deliberation complete', {
      stepsExecuted,
      totalLatencyMs,
      totalPromptTokens,
      totalCompletionTokens,
      confidence: +confidence.toFixed(3),
      knowledgeGrounding,
      discoveredEntities: discoveredEntities.length,
      responsePreview: finalResponseText.substring(0, 100),
    });

    this.logger.log(
      `Deliberation complete: ${stepsExecuted} steps, ${totalLatencyMs}ms, ` +
        `${totalPromptTokens + totalCompletionTokens} tokens, ` +
        `confidence=${confidence.toFixed(2)}`,
    );

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Build flat context string when WorkingMemoryService is unavailable.
   * Preserves the original behavior for graceful degradation.
   */
  private buildFlatContext(
    wkg: WkgContext,
    driveSnapshot: DriveSnapshot,
    context: CognitiveContext,
    frame: SensoryFrame,
  ): string {
    const sceneDescription = (frame.raw['scene_description'] as string | undefined) ?? '';
    const parts: string[] = [];

    parts.push(wkg.summary ? `What I know:\n${wkg.summary}` : 'What I know: Nothing specific yet.');
    if (sceneDescription) parts.push(`What I see:\n${sceneDescription}`);

    const driveSummary = buildDriveSummary(driveSnapshot);
    if (driveSummary) parts.push(`How I'm feeling: ${driveSummary}`);

    const episodeSummary = buildEpisodeSummary(context);
    if (episodeSummary) parts.push(`Recent conversation:\n${episodeSummary}`);

    return parts.join('\n');
  }

  /**
   * Build the no-deliberation fallback result.
   *
   * When `degraded` is true the LLM was unavailable (Lesion Test / circuit
   * breaker), so deliberation could not run at all. CANON §The Lesion Test
   * requires the mind to keep standing without the LLM: rather than returning an
   * empty string (which the decision layer would suppress, leaving Sylphie
   * silently mute), we return an honest admission of incomprehension. The text
   * is deliberately an ignorance response (matched by isIgnoranceResponse), so
   * grounding stays UNKNOWN and the decision layer emits a SHRUG CycleResponse.
   */
  private fallbackResult(reason: string, degraded = false): DeliberationResult {
    const responseText = degraded ? NO_LLM_SHRUG_TEXT : '';
    return {
      responseText,
      confidence: 0,
      rationale: reason,
      knowledgeGrounding: 'UNKNOWN',
      // Classification could not run (LLM unavailable) — honest UNKNOWN intent.
      intent: 'UNKNOWN',
      candidates: [],
      trace: {
        innerMonologue: reason,
        candidates: [],
        selectedCandidate: responseText,
        debate: null,
        arbiterRationale: reason,
        confidence: 0,
        stepsExecuted: 0,
      },
      discoveredEntities: [],
      totalTokens: { prompt: 0, completion: 0 },
      totalLatencyMs: 0,
      actionRequest: null,
      degradedNoLlm: degraded,
      // No scoring ran on the fallback path — no factors to thread.
      winningCandidateFactors: [],
    };
  }
}
