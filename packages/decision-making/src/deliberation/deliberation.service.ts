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
import type { OllamaLlmService } from '../llm/ollama-llm.service';
import { ToolRegistryService } from './tools/tool-registry';
import { ContextWindowService } from './context-window.service';
import type { IEpisodicMemoryService, IDecisionEventLogger } from '../interfaces/decision-making.interfaces';
import { EPISODIC_MEMORY_SERVICE, DECISION_EVENT_LOGGER } from '../decision-making.tokens';

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

  /** New entity names discovered during deliberation. */
  readonly discoveredEntities: readonly string[];

  /** Total LLM tokens used across all steps. */
  readonly totalTokens: { prompt: number; completion: number };

  /** Total latency across all LLM calls. */
  readonly totalLatencyMs: number;
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
  ) {}

  /**
   * Run the full deliberation pipeline for a novel situation.
   *
   * Called when Type 1 has no answer (latent space miss) and the executor
   * needs to reason through the response from scratch.
   *
   * @param frame   - The current sensory frame (carries raw input + embedding).
   * @param context - Cognitive context (drive state, episodes, gap types).
   * @returns DeliberationResult with the response and full reasoning trace.
   */
  async deliberate(
    frame: SensoryFrame,
    context: CognitiveContext,
  ): Promise<DeliberationResult> {
    if (!this.llm || !this.llm.isAvailable()) {
      vlog('deliberation aborted: LLM unavailable');
      return this.fallbackResult('LLM service unavailable');
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
    const driveSummary = buildDriveSummary(driveSnapshot);
    const episodeSummary = buildEpisodeSummary(context);
    const conversationHistory = frame.raw['conversation_history'] as LlmMessage[] | undefined ?? [];
    const speakerName = frame.raw['speaker_name'] as string | undefined ?? 'the person talking to you';
    const sceneDescription = frame.raw['scene_description'] as string | undefined ?? '';

    // ── Step 1: Inner Monologue (classification + potential early response) ──
    this.logger.debug('Deliberation step 1: Inner monologue');

    const monologueCtx = this.contextWindow.assemble({
      step: 'INNER_MONOLOGUE',
      reservedForGeneration: STEP_MAX_TOKENS,
      systemParts: [
        `You are Sylphie, a developing cognitive being. The person talking to you is ${speakerName}.`,
        `IMPORTANT: Your name is Sylphie. The OTHER person's name is ${speakerName}. Do NOT confuse these.`,
        `When you greet or address them, use THEIR name (${speakerName}), never your own name (Sylphie).`,
        '',
        'Classify the input and respond. Use EXACTLY this format:',
        '',
        '[INTENT: GREETING]',
        '[ENTITY: none]',
        `[THOUGHT: ${speakerName} is saying hello]`,
        `[RESPONSE: Hi ${speakerName}!]`,
        '',
        'Intent types: GREETING, EMOTION, QUESTION, FACT, COMMAND, UNKNOWN',
        '',
        'Rules:',
        '- GREETING/EMOTION: Always respond naturally. You can always do this.',
        `- FACT (someone telling you something): Acknowledge it. "My name is X" means THEIR name is X.`,
        '- QUESTION about something said in this conversation: Answer from the conversation.',
        '- QUESTION about world knowledge: Check "What I know" below. If not there, say you don\'t know.',
        '- Things said in this conversation are things you know. You do not need world knowledge for them.',
        '- If this needs complex reasoning, write NEEDS_DELIBERATION as the response.',
        '',
        wkg.summary ? `What I know:\n${wkg.summary}` : 'What I know: Nothing specific yet.',
        sceneDescription ? `What I see:\n${sceneDescription}` : '',
        driveSummary ? `How I\'m feeling: ${driveSummary}` : '',
        episodeSummary ? `Recent conversation:\n${episodeSummary}` : '',
        '',
        'MORE EXAMPLES:',
        '',
        `User: "My name is ${speakerName}."`,
        '[INTENT: FACT]',
        `[ENTITY: ${speakerName}]`,
        `[THOUGHT: They are telling me their name is ${speakerName}]`,
        `[RESPONSE: Nice to meet you, ${speakerName}!]`,
        '',
        'User: "What is my name?"',
        '[INTENT: QUESTION]',
        `[ENTITY: ${speakerName}]`,
        `[THOUGHT: They asked their name. I know it is ${speakerName}]`,
        `[RESPONSE: Your name is ${speakerName}!]`,
        '',
        'User: "What is the capital of France?"',
        '[INTENT: QUESTION]',
        '[ENTITY: France]',
        '[THOUGHT: A world knowledge question. I need to check what I know]',
        '[RESPONSE: NEEDS_DELIBERATION]',
      ],
      currentMessages: [
        { role: 'user', content: rawText || 'No specific input — drive pressure triggered this cycle.' },
      ],
      conversationHistory,
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
        // Honest "I don't know" — WKG was consulted but couldn't answer.
        knowledgeGrounding = 'UNKNOWN';
      } else if (monologueParsed.intent === 'GREETING' || monologueParsed.intent === 'EMOTION') {
        // Conversational exchanges are social, not WKG-backed.
        knowledgeGrounding = 'LLM_ASSISTED';
      } else if (wkg.entities.length > 0 || wkg.facts.length > 0) {
        knowledgeGrounding = 'GROUNDED';
      } else {
        knowledgeGrounding = 'UNKNOWN';
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

      return {
        responseText: monologueParsed.response,
        confidence: monologueParsed.intent === 'GREETING' || monologueParsed.intent === 'EMOTION' ? 0.85 : 0.6,
        rationale: monologueParsed.thought ?? 'Resolved by inner monologue',
        knowledgeGrounding,
        candidates: [{ text: monologueParsed.response, reasoning: 'Direct monologue response' }],
        trace: {
          innerMonologue,
          candidates: [{ text: monologueParsed.response, reasoning: 'Direct monologue response' }],
          selectedCandidate: monologueParsed.response,
          debate: null,
          arbiterRationale: 'Short-circuited — no deliberation needed',
          confidence: monologueParsed.intent === 'GREETING' || monologueParsed.intent === 'EMOTION' ? 0.85 : 0.6,
          stepsExecuted: 1,
        },
        discoveredEntities: monologueParsed.entity && monologueParsed.entity !== 'none'
          ? [monologueParsed.entity] : [],
        totalTokens: { prompt: totalPromptTokens, completion: totalCompletionTokens },
        totalLatencyMs,
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
        wkg.summary ? `\nWhat I know:\n${wkg.summary}` : '\nWhat I know: Nothing about the world yet.',
        sceneDescription ? `\nWhat I see:\n${sceneDescription}` : '',
        driveSummary ? `\nHow I'm feeling: ${driveSummary}` : '',
      ],
      currentMessages: [
        { role: 'user' as const, content: rawText || innerMonologue },
      ],
      conversationHistory,
    });

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

    // Determine knowledge grounding: parsed tag > WKG inference > default.
    // Pass the cleaned response text so inferGrounding can detect ignorance admissions.
    let knowledgeGrounding: KnowledgeGrounding = parsedGrounding
      ?? inferGrounding(wkg, cleanedText);

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
          wkg.summary ? `Known facts: ${wkg.summary}` : '',
          episodeSummary ? `Recent experience: ${episodeSummary}` : '',
        ],
        currentMessages: [
          { role: 'user', content: `Argue FOR this response being appropriate: "${selected.text}"\n\nContext: Someone said "${rawText}"` },
        ],
        conversationHistory,
      });

      const againstCtx = this.contextWindow.assemble({
        step: 'DEBATE_AGAINST',
        reservedForGeneration: STEP_MAX_TOKENS,
        systemParts: [
          'Argue why this response might be wrong, inappropriate, or harmful. Consider:',
          '- Does it contradict anything I know?',
          '- Does it match my current emotional state?',
          '- Could it be misunderstood?',
          wkg.summary ? `Known facts: ${wkg.summary}` : '',
        ],
        currentMessages: [
          { role: 'user', content: `Argue AGAINST this response being appropriate: "${selected.text}"\n\nContext: Someone said "${rawText}"` },
        ],
        conversationHistory,
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
          driveSummary ? `Current state: ${driveSummary}` : '',
          wkg.summary ? `Known facts: ${wkg.summary}` : 'Known facts: None relevant.',
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
        conversationHistory,
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
    // If the arbiter's modified text had a tag, let it update the grounding
    if (finalTagParse.grounding) {
      knowledgeGrounding = finalTagParse.grounding;
    }

    // Final guard: an ignorance admission can never be GROUNDED regardless of
    // what tag the arbiter attached (LLM sometimes emits tags incorrectly).
    if (isIgnoranceResponse(finalResponseText) && knowledgeGrounding === 'GROUNDED') {
      knowledgeGrounding = 'UNKNOWN';
    }

    // Extract any new entity names mentioned in the response
    const discoveredEntities = extractNewEntities(finalResponseText, wkg);

    const result: DeliberationResult = {
      responseText: finalResponseText,
      confidence,
      rationale,
      knowledgeGrounding,
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

  private fallbackResult(reason: string): DeliberationResult {
    return {
      responseText: '',
      confidence: 0,
      rationale: reason,
      knowledgeGrounding: 'UNKNOWN',
      candidates: [],
      trace: {
        innerMonologue: reason,
        candidates: [],
        selectedCandidate: '',
        debate: null,
        arbiterRationale: reason,
        confidence: 0,
        stepsExecuted: 0,
      },
      discoveredEntities: [],
      totalTokens: { prompt: 0, completion: 0 },
      totalLatencyMs: 0,
    };
  }
}

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

  let intent = (intentMatch?.[1]?.toUpperCase() ?? 'UNKNOWN') as MonologueClassification['intent'];
  const entity = entityMatch?.[1]?.trim() ?? null;
  const thought = thoughtMatch?.[1]?.trim() ?? null;
  let response = responseMatch?.[1]?.trim() ?? null;

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
  // Short-circuit is only valid for simple conversational intents where a
  // one-step monologue response is architecturally sufficient:
  //   GREETING, EMOTION, FACT — no reasoning required, direct response is fine.
  //
  // QUESTION always proceeds to full deliberation even when the monologue
  // produced a plausible-looking response. The monologue's response text is
  // still used as inner-thought context in step 2 candidate generation, so it
  // is not wasted — it just does not short-circuit the pipeline.
  //
  // UNKNOWN and COMMAND already force deliberation; QUESTION is added here.
  const needsDeliberation = !response
    || response.toUpperCase().includes('NEEDS_DELIBERATION')
    || intent === 'UNKNOWN'
    || intent === 'COMMAND'
    || intent === 'QUESTION';

  return { intent, entity, thought, response, needsDeliberation };
}

/**
 * Returns true when the response text is an honest admission of ignorance.
 * An ignorance response is NEVER GROUNDED — the WKG state is irrelevant.
 *
 * Matches first-person denials: "I don't know", "I'm not sure", "I have no
 * idea", "I don't have access to", "I can't recall", etc.
 */
function isIgnoranceResponse(text: string): boolean {
  return /\b(i\s+don'?t\s+know|i\s+have\s+no\s+(idea|information|knowledge|record|way\s+to\s+know)|i\s+'?m\s+not\s+sure|i\s+can'?t\s+(recall|remember|tell|say)|i\s+do\s+not\s+know|no\s+information\s+about)\b/i.test(text);
}

/**
 * Infer knowledge grounding from WKG context and the actual response text.
 *
 * Rules (in priority order):
 *   1. If the response is an honest admission of ignorance → UNKNOWN.
 *      WKG context may have been loaded but was not enough to answer; the
 *      response itself is the ground truth for what was communicated.
 *   2. If WKG had matching entities or facts → GROUNDED (response used them).
 *   3. Otherwise → LLM_ASSISTED (general LLM knowledge, no WKG backing).
 */
function inferGrounding(wkg: WkgContext, responseText: string): KnowledgeGrounding {
  if (isIgnoranceResponse(responseText)) {
    return 'UNKNOWN';
  }
  if (wkg.entities.length > 0 || wkg.facts.length > 0) {
    return 'GROUNDED';
  }
  return 'LLM_ASSISTED';
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
