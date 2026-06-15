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
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import {
  LLM_SERVICE,
  DriveName,
  type ILlmService,
  type LlmMessage,
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

      // ── WS3 Ticket T1 — grounding from the PRE-ARBITRATION recall retrieval ─
      // When the cycle resolved a recall fact node before arbitration, the label
      // is upgraded to GROUNDED off that ONCE-resolved node id (with the value-
      // surfaced honesty guard inside applyRecallGroundingFromRetrieval), and the
      // node id flows out as provenance. Non-recall turns (retrieval === null)
      // fall back to the legacy post-hoc helper — TRANSITIONAL: that helper only
      // ever upgrades via OKG recall, which the pre-arbitration step now owns, so
      // for recall turns it is a no-op; it remains only to avoid regressing any
      // non-recall path that historically depended on it.
      let groundingProvenance: string | null;
      let groundedBy: 'OKG' | 'WKG' | null;
      if (recallRetrieval) {
        const applied = applyRecallGroundingFromRetrieval(
          recallRetrieval, responseText, knowledgeGrounding,
        );
        knowledgeGrounding = applied.grounding;
        groundingProvenance = applied.provenance;
        groundedBy = applied.groundedBy;
        if (groundingProvenance) {
          this.logger.debug(
            `Recall grounded (short-circuit, pre-arbitration): node="${groundingProvenance}" ` +
              `source=${groundedBy} response="${responseText.substring(0, 60)}"`,
          );
        }
      } else {
        const shortCircuitOkg = applyOkgRecallGrounding(
          personModel?.personId, rawText, responseText, personModel?.knownFacts, knowledgeGrounding,
        );
        knowledgeGrounding = shortCircuitOkg.grounding;
        groundingProvenance = shortCircuitOkg.provenance;
        groundedBy = discriminateGroundedBy(
          knowledgeGrounding, wkg, responseText, personModel?.knownFacts, groundingProvenance,
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

    // ── WS3 Ticket T1 — grounding from the PRE-ARBITRATION recall retrieval ───
    // TYPE_2 NOVEL recall turns (no procedure node) consume the same once-resolved
    // node id as every other path. Non-recall novel turns fall back to the legacy
    // post-hoc helper (transitional — a no-op for grounding except via OKG recall,
    // which the pre-arbitration step now owns).
    let groundingProvenance: string | null;
    let groundedBy: 'OKG' | 'WKG' | null;
    if (recallRetrieval) {
      const applied = applyRecallGroundingFromRetrieval(
        recallRetrieval, finalResponseText, knowledgeGrounding,
      );
      knowledgeGrounding = applied.grounding;
      groundingProvenance = applied.provenance;
      groundedBy = applied.groundedBy;
      if (groundingProvenance) {
        this.logger.debug(
          `Recall grounded (novel-deliberation, pre-arbitration): node="${groundingProvenance}" ` +
            `source=${groundedBy} response="${finalResponseText.substring(0, 60)}"`,
        );
      }
    } else {
      const novelOkg = applyOkgRecallGrounding(
        personModel?.personId, rawText, finalResponseText, personModel?.knownFacts, knowledgeGrounding,
      );
      knowledgeGrounding = novelOkg.grounding;
      groundingProvenance = novelOkg.provenance;
      groundedBy = discriminateGroundedBy(
        knowledgeGrounding, wkg, finalResponseText, personModel?.knownFacts, groundingProvenance,
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
  // Fallback
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
    };
  }
}

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
// Parsing helpers
// ---------------------------------------------------------------------------

/** Parse numbered candidate list from LLM output. */
function parseCandidates(text: string): DeliberationCandidate[] {
  const candidates: DeliberationCandidate[] = [];
  const lines = text.split('\n').filter((l) => l.trim().length > 0);

  for (const line of lines) {
    // Match patterns like "1. response text — reasoning" or "1) response"
    const match = line.match(/^\d+[\.\)]\s*(.+?)(?:\s*[-—–]\s*(.+))?$/);
    if (match) {
      candidates.push({
        text: match[1].trim().replace(/^["']|["']$/g, ''),
        reasoning: match[2]?.trim() ?? '',
      });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Deterministic candidate scoring (replaces LLM selection call)
// ---------------------------------------------------------------------------

/** Chatbot/assistant phrases that should be penalized. */
const CHATBOT_RE = /\b(as an AI|I'?m here to help|how can I assist|how may I help|I don'?t have feelings|I'?m just a|language model|I'?m an? (?:AI|artificial)|I cannot feel|I am not able to)\b/i;

/** "I don't know" hedging patterns. */
const IDK_RE = /\bI don'?t (?:really )?know\b/i;

interface CandidateScore {
  readonly score: number;
  readonly factors: string[];
}

interface ScoredSelection {
  readonly bestIndex: number;
  readonly scores: readonly CandidateScore[];
  readonly rationale: string;
}

/**
 * Score each candidate deterministically and pick the best one.
 *
 * Replaces the Step 3 LLM call. The rules encoded here mirror the selection
 * prompt that was previously sent to the LLM:
 *   - Prefer GROUNDED candidates for conversational input
 *   - Penalize "I don't know" for greetings/emotion/facts
 *   - Penalize chatbot/assistant language
 *   - Bonus for referencing known WKG entities
 *   - Prefer concise responses
 */
function scoreCandidates(
  candidates: DeliberationCandidate[],
  intent: MonologueClassification['intent'],
  wkg: WkgContext,
): ScoredSelection {
  const isConversational = intent === 'GREETING' || intent === 'EMOTION' || intent === 'FACT';

  const scores: CandidateScore[] = candidates.map((candidate) => {
    let score = 0;
    const factors: string[] = [];
    const { grounding } = parseGroundingTag(candidate.text);

    // ── Grounding weight ──────────────────────────────────────────────
    if (grounding === 'GROUNDED') {
      score += 1.0;
      factors.push('grounded:+1.0');
    } else if (grounding === 'LLM_ASSISTED') {
      score += 0.5;
      factors.push('assisted:+0.5');
    } else if (grounding === 'UNKNOWN') {
      score += isConversational ? 0.1 : 0.7;
      factors.push(isConversational ? 'unknown-conv:+0.1' : 'unknown-factual:+0.7');
    } else {
      score += 0.5;
      factors.push('untagged:+0.5');
    }

    // ── Chatbot language penalty ──────────────────────────────────────
    if (CHATBOT_RE.test(candidate.text)) {
      score -= 0.5;
      factors.push('chatbot:-0.5');
    }

    // ── "I don't know" penalty in conversational context ──────────────
    if (isConversational && IDK_RE.test(candidate.text)) {
      score -= 0.7;
      factors.push('idk-conv:-0.7');
    }

    // ── Question-ending penalty (candidates should not ask questions) ─
    if (candidate.text.trimEnd().endsWith('?')) {
      score -= 0.15;
      factors.push('ends-?:-0.15');
    }

    // ── WKG entity mention bonus ──────────────────────────────────────
    if (wkg.entities.length > 0) {
      const lower = candidate.text.toLowerCase();
      const mentionsKnown = wkg.entities.some((e) =>
        lower.includes(e.label.toLowerCase()),
      );
      if (mentionsKnown) {
        score += 0.15;
        factors.push('entity:+0.15');
      }
    }

    // ── Verbosity penalty ─────────────────────────────────────────────
    if (candidate.text.split(/\s+/).length > 50) {
      score -= 0.1;
      factors.push('verbose:-0.1');
    }

    return { score, factors };
  });

  // Pick the highest-scoring candidate. On ties, prefer the first (position bias).
  let bestIndex = 0;
  let bestScore = scores[0].score;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i].score > bestScore) {
      bestScore = scores[i].score;
      bestIndex = i;
    }
  }

  const rationale =
    `Scored selection: candidate ${bestIndex + 1} (${bestScore.toFixed(2)}) — ` +
    scores[bestIndex].factors.join(', ');

  return { bestIndex, scores, rationale };
}

/** Parse the arbiter's decision. */
function parseArbiterDecision(
  text: string,
  originalText: string,
): { text: string; confidence: number; rationale: string; action: string } {
  const lower = text.toLowerCase();
  let action = 'APPROVE';
  let responseText = originalText;
  let confidence = 0.6;

  if (lower.startsWith('reject')) {
    action = 'REJECT';
    confidence = 0.3;
    // Try to extract alternative response from "REJECT — alternative" or "REJECT: alternative"
    const rejectMatch = text.match(/reject\s*[:\-—–]+\s*["']?(.+?)["']?\s*(?:confidence|rating|$)/is);
    if (rejectMatch && rejectMatch[1].trim().length > 5) {
      responseText = rejectMatch[1].trim();
      confidence = 0.4; // Slightly higher since we have an alternative
    }
    // If no alternative extracted, keep original but lower confidence
  } else if (lower.startsWith('modify')) {
    action = 'MODIFY';
    confidence = 0.5;
    // Try to extract modified text
    const modMatch = text.match(/modify\s*[:\-—–]?\s*["']?(.+?)["']?\s*(?:confidence|rating|$)/is);
    if (modMatch && modMatch[1].trim().length > 3) {
      responseText = modMatch[1].trim();
    }
  } else {
    action = 'APPROVE';
    confidence = 0.7;
  }

  // Try to extract confidence score (0-10)
  const confMatch = text.match(/(?:confidence|rating)[:\s]*(\d+)/i);
  if (confMatch) {
    confidence = Math.min(1.0, parseInt(confMatch[1], 10) / 10);
  }

  return { text: responseText, confidence, rationale: text.trim(), action };
}

/**
 * Parse a [GROUNDED], [ASSISTED], or [UNKNOWN] tag from candidate text.
 * Returns the cleaned text and the parsed grounding (or null if no tag found).
 * Also strips any other bracket-wrapped prefixes that leak from the LLM.
 */
function parseGroundingTag(text: string): { text: string; grounding: KnowledgeGrounding | null } {
  let cleaned = text;
  let grounding: KnowledgeGrounding | null = null;

  // Strip leading grounding tags: [GROUNDED], [ASSISTED], [UNKNOWN]
  const groundingMatch = cleaned.match(/^\[?(GROUNDED|ASSISTED|UNKNOWN)\]?\s*/i);
  if (groundingMatch) {
    const tag = groundingMatch[1].toUpperCase();
    cleaned = cleaned.substring(groundingMatch[0].length).trim();
    grounding =
      tag === 'GROUNDED' ? 'GROUNDED'
        : tag === 'ASSISTED' ? 'LLM_ASSISTED'
          : 'UNKNOWN';
  }

  // Strip any remaining bracket-wrapped text at the start (e.g., "[Hi there!...]")
  // that looks like leaky formatting from the LLM
  if (cleaned.startsWith('[') && !cleaned.startsWith('[...')) {
    const bracketEnd = cleaned.indexOf(']');
    if (bracketEnd > 0 && bracketEnd < cleaned.length - 1) {
      // There's text after the bracket — extract what's inside as the response
      const inside = cleaned.substring(1, bracketEnd).trim();
      const after = cleaned.substring(bracketEnd + 1).trim();
      // Use the content that looks more like a natural response
      cleaned = after.length > 3 ? after : inside;
    } else if (bracketEnd === cleaned.length - 1) {
      // The whole response is wrapped in brackets — unwrap it
      cleaned = cleaned.substring(1, bracketEnd).trim();
    }
  }

  // Strip trailing artifacts: lone brackets, grounding tags at end
  cleaned = cleaned.replace(/\s*\[(?:GROUNDED|ASSISTED|UNKNOWN)\]\s*$/i, '').trim();

  return { text: cleaned, grounding };
}

/** Parsed result of the inner monologue's structured classification. */
interface MonologueClassification {
  readonly intent: 'GREETING' | 'EMOTION' | 'QUESTION' | 'FACT' | 'COMMAND' | 'UNKNOWN';
  readonly entity: string | null;
  readonly thought: string | null;
  readonly response: string | null;
  readonly needsDeliberation: boolean;
  /** For COMMAND intents: the action type requested (e.g., 'RESEARCH_ENTITY'). */
  readonly actionType: string | null;
}

/**
 * Parse the structured classification from the inner monologue output.
 *
 * Expects format:
 *   [INTENT: GREETING]
 *   [ENTITY: none]
 *   [THOUGHT: This is a simple greeting]
 *   [RESPONSE: Hey there!]
 *
 * Falls back gracefully — if structured parsing fails, attempts to extract
 * a usable response from free-form text (common with smaller local models).
 */
function parseMonologueClassification(text: string): MonologueClassification {
  const intentMatch = text.match(/\[INTENT:\s*(GREETING|EMOTION|QUESTION|FACT|COMMAND|UNKNOWN)\s*\]/i);
  const entityMatch = text.match(/\[ENTITY:\s*(.+?)\s*\]/i);
  const thoughtMatch = text.match(/\[THOUGHT:\s*(.+?)\s*\]/i);
  const responseMatch = text.match(/\[RESPONSE:\s*([\s\S]+?)(?:\]|$)/i);
  const actionMatch = text.match(/\[ACTION:\s*(\w+)\s*\]/i);

  let intent = (intentMatch?.[1]?.toUpperCase() ?? 'UNKNOWN') as MonologueClassification['intent'];
  const entity = entityMatch?.[1]?.trim() ?? null;
  const thought = thoughtMatch?.[1]?.trim() ?? null;
  let response = responseMatch?.[1]?.trim() ?? null;
  const actionType = actionMatch?.[1]?.toUpperCase() ?? null;

  // Clean up the response — strip trailing bracket if captured
  if (response) {
    response = response.replace(/\]$/, '').trim();
    if (response.toUpperCase() === 'NEEDS_DELIBERATION') {
      response = null;
    }
  }

  // ── Fallback: if the model didn't follow structured format, try to ──
  // ── infer intent and extract a response from free-form text.       ──
  if (!intentMatch && !responseMatch) {
    // Infer intent from free-form text
    if (/\b(hello|hi |hey |greet|nice to meet|welcome)\b/i.test(text)) {
      intent = 'GREETING';
    } else if (/\b(feel|emotion|happy|sad|anxious|excited)\b/i.test(text)) {
      intent = 'EMOTION';
    } else if (/\b(introducing|told me|my name is|their name|fact|stating)\b/i.test(text)) {
      intent = 'FACT';
    } else if (/\b(asking|question|want to know|curious about)\b/i.test(text)) {
      intent = 'QUESTION';
    }

    // For simple conversational intents, extract the first sentence-like
    // segment as a usable response. The model often writes something like
    // "Hello Jim! It's nice to meet you. Since we're just getting started..."
    // — the first part IS a good response.
    if (intent === 'GREETING' || intent === 'EMOTION' || intent === 'FACT') {
      // Look for a natural response within the free-form text.
      // Take up to 2 sentences that sound like a direct response.
      const sentences = text.split(/(?<=[.!?])\s+/);
      const responseParts: string[] = [];
      for (const s of sentences) {
        const trimmed = s.trim();
        // Skip meta-commentary about the conversation
        if (/\b(since we|just getting started|don't have any|without specific|hypothetical)\b/i.test(trimmed)) {
          break;
        }
        if (trimmed.length > 3) {
          responseParts.push(trimmed);
        }
        if (responseParts.length >= 2) break;
      }
      if (responseParts.length > 0) {
        response = responseParts.join(' ');
      }
    }
  }

  // Check if the monologue signaled it needs further deliberation.
  //
  // Short-circuit is valid for:
  //   GREETING, EMOTION, FACT — no reasoning required, direct response is fine.
  //
  // QUESTION and COMMAND always proceed to full deliberation. COMMAND needs
  // the tool-calling step to invoke real actions (research_entity, etc.).
  const needsDeliberation = !response
    || response.toUpperCase().includes('NEEDS_DELIBERATION')
    || intent === 'UNKNOWN'
    || intent === 'COMMAND'
    || intent === 'QUESTION';

  return { intent, entity, thought, response, needsDeliberation, actionType };
}

/**
 * Returns true when the response text is an honest admission of ignorance.
 * An ignorance response is NEVER GROUNDED — the WKG state is irrelevant.
 *
 * Matches first-person denials: "I don't know", "I'm not sure", "I have no
 * idea", "I don't have access to", "I can't recall", etc.
 */
export function isIgnoranceResponse(text: string): boolean {
  return /\b(i\s+don'?t\s+know|i\s+have\s+no\s+(idea|information|knowledge|record|way\s+to\s+know)|i\s+'?m\s+not\s+sure|i\s+can'?t\s+(recall|remember|tell|say)|i\s+do\s+not\s+know|no\s+information\s+about)\b/i.test(text);
}

/**
 * Map a recall question to the specific person-fact KEY it is asking about.
 *
 * Pure, synchronous. Returns the OKG fact key the question targets, or null when
 * the question does not map to a known fact dimension (e.g. unknowables like
 * "what did I have for breakfast"). The corpus teach facts are name / location /
 * dog / favorite_color; occupation is included for the standard "what do I do
 * for work" recall. A null return means this turn cannot be grounded by OKG
 * recall and falls through to the honest WKG/LLM_ASSISTED ladder (C2 safety).
 */
export function recallKeyForQuestion(inputText: string): string | null {
  const t = inputText.toLowerCase();
  // Exclude middle/last/surname/maiden — those are unknowable variants, not the taught first name.
  if (/\b(name|called)\b/.test(t) && !/dog|pet|animal|middle|last|surname|maiden/.test(t)) return 'name';
  // Exclude childhood/birth location — "grow up / grew up / born" ≠ current city.
  // Also removed 'town' which is ambiguous ("what town did I grow up in?" was colliding).
  if (/\b(live|city|location|where)\b/.test(t) && !/grow|grew|born|childhood|raised/.test(t)) return 'location';
  if (/\b(dog|pet|animal|named|called)\b/.test(t)) return 'dog';
  // Exclude other "favorite X" categories — only map when the question is specifically about color.
  if (/\b(color|colour|favourite|favorite)\b/.test(t) && !/food|drink|movie|book|song|music|sport|meal|dish/.test(t)) return 'favorite_color';
  if (/\b(work|job|occupation|profession)\b/.test(t)) return 'occupation';
  return null;
}

/**
 * Retrieve a person fact by key from the fused-stream person model, returning
 * its value and the deterministic provenance id PersonModelService.writeFact
 * computes (`attr-${personId}-${key}`). Mirrors PersonModelService.getFactByKey
 * over the knownFacts the OKG already loaded into the frame — the decision-making
 * package cannot import PersonModelService (it lives in the app), but the
 * provenance id is deterministic and the value comes from the same OKG-loaded
 * facts, so this is a real fact-node retrieval, not LLM text inference.
 *
 * knownFacts arrive as "key: value" strings (getPersonModel builds them as
 * `${key}: ${value}`). Returns null when the key is absent → unknowables and
 * un-taught dimensions stay LLM_ASSISTED/UNKNOWN (C2 safety by construction).
 */
/**
 * WS3 T1 — exported alias of the OKG fact retrieval used by the pre-arbitration
 * recall retrieval step (recall-retrieval.ts). Same deterministic-id lookup over
 * the frame's knownFacts; exported so the single pre-arbitration retrieval can
 * reuse it rather than re-deriving the key→value→provenance mapping.
 */
export function getRecalledFactForRecall(
  personId: string,
  key: string,
  knownFacts: readonly string[] | undefined,
): { key: string; value: string; attrId: string } | null {
  return getRecalledFact(personId, key, knownFacts);
}

function getRecalledFact(
  personId: string,
  key: string,
  knownFacts: readonly string[] | undefined,
): { key: string; value: string; attrId: string } | null {
  if (!knownFacts?.length) return null;
  for (const kf of knownFacts) {
    const colonIdx = kf.indexOf(':');
    if (colonIdx <= 0) continue;
    const k = kf.substring(0, colonIdx).trim();
    if (k !== key) continue;
    const value = kf.substring(colonIdx + 1).trim();
    if (!value) return null;
    return { key, value, attrId: `attr-${personId}-${key}` };
  }
  return null;
}

/**
 * Deterministic OKG recall grounding (CANON Standard 1 provenance-required +
 * Standard 4 theater-prohibition). Returns the provenance id when, and only
 * when, the question maps to a fact key, that fact node exists in the OKG, AND
 * the fact value appears verbatim in the response. Returns null otherwise — so
 * the LLM can never self-assert grounding and unknowables can never falsely read
 * GROUNDED. The caller upgrades knowledgeGrounding to GROUNDED on a non-null.
 */
export function okgRecallProvenance(
  personId: string | undefined,
  inputText: string,
  responseText: string,
  knownFacts: readonly string[] | undefined,
): string | null {
  if (!personId) return null;
  const key = recallKeyForQuestion(inputText);
  if (!key) return null;
  const fact = getRecalledFact(personId, key, knownFacts);
  if (!fact) return null;
  const valueLower = fact.value.toLowerCase();
  if (valueLower.length < 2) return null;
  return responseText.toLowerCase().includes(valueLower) ? fact.attrId : null;
}

/**
 * Shared helper: upgrade grounding to GROUNDED if OKG recall provenance is
 * available. Called from both the deliberation pipeline and the procedure-handler
 * path so the same logic covers TYPE_2 NOVEL and TYPE_2 PROCEDURE recall turns.
 * Returns current grounding unchanged when already GROUNDED or no provenance.
 */
export function applyOkgRecallGrounding(
  personId: string | undefined,
  inputText: string,
  responseText: string,
  knownFacts: readonly string[] | undefined,
  currentGrounding: KnowledgeGrounding,
): { grounding: KnowledgeGrounding; provenance: string | null } {
  if (currentGrounding === 'GROUNDED') return { grounding: currentGrounding, provenance: null };
  const provenance = okgRecallProvenance(personId, inputText, responseText, knownFacts);
  return provenance
    ? { grounding: 'GROUNDED', provenance }
    : { grounding: currentGrounding, provenance: null };
}

/**
 * True iff a taught person-model (OKG) fact VALUE surfaces in the response text.
 *
 * `knownFacts` come as "key: value" strings (person-model.service.ts builds them
 * as `${key}: ${value}`). We match on the VALUE side so that genuine recall of a
 * taught fact ("Your name is Jim" ⟵ "name: Jim") counts as GROUNDED-by-recall,
 * while an unknowable asked while OTHER facts are known ("my shoe size", with
 * knownFacts = {name, city}) does NOT falsely read GROUNDED — its value never
 * appears in the reply. A miss degrades to the WKG/LLM_ASSISTED ladder: honest,
 * and structurally incapable of producing a false GROUNDED. This is the OKG half
 * of grounding that the old WKG-only check missed (Standard-1 provenance).
 */
export function personFactRecalled(
  knownFacts: readonly string[] | undefined,
  responseText: string,
): boolean {
  if (!knownFacts?.length) return false;
  const text = responseText.toLowerCase();
  return knownFacts.some((kf) => {
    // Value side of "key: value" (re-join in case the value itself has a colon).
    const value = kf.split(':').slice(1).join(':').trim().toLowerCase();
    return value.length >= 2 && text.includes(value);
  });
}

/**
 * True iff the WKG context carries a REAL topical entity, as opposed to the
 * Drive/CoBeing base-context that getContextForFrame() returns for any input
 * without a proper-noun match. Base-context entities must not, on their own,
 * count as GROUNDED — otherwise every nounless question (including unknowables)
 * reads grounded off the always-present self/drive nodes (Trap A).
 */
function hasTopicalEntity(wkg: WkgContext): boolean {
  return wkg.entities.some((e) => e.nodeType !== 'Drive' && e.nodeType !== 'CoBeing');
}

/**
 * Infer knowledge grounding from the response text, OKG person-facts, and WKG
 * context. GROUNDED means the SYSTEM verified provenance backs the response —
 * never that the LLM asserted it.
 *
 * Rules (in priority order):
 *   1. Honest admission of ignorance → UNKNOWN (the response is ground truth).
 *   2. A taught person-model fact value surfaced in the reply → GROUNDED (OKG recall).
 *   3. Real topical WKG backing — facts, or a non-base-context entity → GROUNDED.
 *   4. Otherwise → LLM_ASSISTED (general LLM knowledge, no self-knowledge backing).
 */
export function inferGrounding(
  wkg: WkgContext,
  responseText: string,
  knownFacts?: readonly string[],
): KnowledgeGrounding {
  if (isIgnoranceResponse(responseText)) {
    return 'UNKNOWN';
  }
  if (personFactRecalled(knownFacts, responseText)) {
    return 'GROUNDED';
  }
  if (wkg.facts.length > 0 || hasTopicalEntity(wkg)) {
    return 'GROUNDED';
  }
  return 'LLM_ASSISTED';
}

/**
 * WS4 Ticket 5 (§3.1) — discriminate WHICH knowledge source grounded a verdict.
 *
 * This mirrors the EXACT priority cascade `inferGrounding`/the short-circuit
 * path use (OKG person-fact recall wins over topical WKG), so the source is
 * read off the SAME rule that produced the GROUNDED verdict — not re-derived
 * from ambient context. That is the whole point: a verdict can be
 * GROUNDED-because-of-OKG while the WKG context independently contains an
 * unrelated topical entity. Re-deriving "is there a topical entity?" would
 * mislabel that OKG fact as WKG-backed and world-scope a private fact (the bug
 * mythos live-verified). Discriminating by rule precedence cannot.
 *
 * Priority (highest first), matching the grounding cascade:
 *   1. `okgProvenance` non-null (applyOkgRecallGrounding upgraded it) → 'OKG'.
 *   2. `personFactRecalled` (a taught fact VALUE surfaced in the reply) → 'OKG'.
 *   3. real WKG fact or topical (non-base) entity → 'WKG'.
 *   4. anything else GROUNDED (e.g. LLM tag we couldn't attribute) → null
 *      → the write site person-scopes (conservative-when-ambiguous).
 *
 * Returns null when grounding !== 'GROUNDED'.
 */
export function discriminateGroundedBy(
  grounding: KnowledgeGrounding,
  wkg: WkgContext,
  responseText: string,
  knownFacts: readonly string[] | undefined,
  okgProvenance: string | null,
): 'OKG' | 'WKG' | null {
  if (grounding !== 'GROUNDED') return null;
  // Rule 1 + 2 — OKG person-fact recall (private self-knowledge).
  if (okgProvenance) return 'OKG';
  if (personFactRecalled(knownFacts, responseText)) return 'OKG';
  // Rule 3 — shared world-knowledge backing.
  if (wkg.facts.length > 0 || hasTopicalEntity(wkg)) return 'WKG';
  // Rule 4 — GROUNDED but source unattributable (e.g. an LLM grounding tag the
  // arbiter attached that survived re-verification). Ambiguous → person-scope.
  return null;
}

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

function buildDriveSummary(snapshot: DriveSnapshot): string {
  const drives = snapshot.pressureVector;
  const active = Object.entries(drives)
    .filter(([, v]) => (v as number) > 0.2)
    .map(([name, v]) => `${name}: ${(v as number).toFixed(2)}`)
    .join(', ');
  return active || 'calm (all drives low)';
}

function buildEpisodeSummary(context: CognitiveContext): string {
  return context.recentEpisodes
    .slice(0, 5)
    .map((ep) => ep.inputSummary)
    .filter((s) => s.length > 0)
    .join('\n') || '';
}

/** Find entity names in the response that aren't already in the WKG. */
function extractNewEntities(text: string, wkg: WkgContext): string[] {
  const knownLabels = new Set(wkg.entities.map((e) => e.label.toLowerCase()));
  const words = text.split(/\s+/);
  const newEntities: string[] = [];

  for (const word of words) {
    const clean = word.replace(/[.,!?;:'"]/g, '');
    if (clean.length > 2 && /^[A-Z]/.test(clean) && !knownLabels.has(clean.toLowerCase())) {
      newEntities.push(clean);
    }
  }

  return [...new Set(newEntities)];
}
