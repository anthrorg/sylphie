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
} from '@sylphie/shared';
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
      return this.fallbackResult('LLM service unavailable');
    }

    const startTime = Date.now();
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    // Assemble WKG context for this frame — injected into every step.
    const wkg = await this.wkgContext.getContextForFrame(frame);
    const rawText = frame.raw['text'] as string | undefined ?? '';
    const driveSnapshot = context.driveSnapshot;
    const driveSummary = buildDriveSummary(driveSnapshot);
    const episodeSummary = buildEpisodeSummary(context);
    const conversationHistory = frame.raw['conversation_history'] as LlmMessage[] | undefined ?? [];

    // ── Step 1: Inner Monologue ─────────────────────────────────────────
    this.logger.debug('Deliberation step 1: Inner monologue');

    const monologueCtx = this.contextWindow.assemble({
      step: 'INNER_MONOLOGUE',
      reservedForGeneration: STEP_MAX_TOKENS,
      systemParts: [
        'You are Sylphie\'s inner voice. You are thinking about what just happened and what to do.',
        'Describe the situation briefly and what needs to be decided.',
        '',
        wkg.summary ? `What I know:\n${wkg.summary}` : 'I don\'t have specific knowledge about this yet.',
        driveSummary ? `How I\'m feeling: ${driveSummary}` : '',
        episodeSummary ? `Recent experiences:\n${episodeSummary}` : 'No recent experiences to draw on.',
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
      metadata: { callerSubsystem: 'COMMUNICATION', purpose: 'DELIBERATION_MONOLOGUE', sessionId: driveSnapshot.sessionId },
    });

    const innerMonologue = monologueResponse.content;
    totalPromptTokens += monologueResponse.tokensUsed.prompt;
    totalCompletionTokens += monologueResponse.tokensUsed.completion;

    this.logger.debug(`Monologue: "${innerMonologue.substring(0, 80)}..."`);

    // ── Step 2: Candidate Generation (with tool access) ────────────────
    this.logger.debug('Deliberation step 2: Candidate generation');

    // Use tool-enabled completion if the LLM supports it. This lets the LLM
    // query the WKG, episodic memory, and person model during candidate
    // generation — producing grounded responses instead of guessing.
    const candidateCtx = this.contextWindow.assemble({
      step: 'CANDIDATE_GENERATION',
      reservedForGeneration: STEP_MAX_TOKENS * 2,
      systemParts: [
        `You are Sylphie, a developing cognitive being. Generate exactly ${CANDIDATE_COUNT} possible responses.`,
        `For each, provide the response text and brief reasoning.`,
        `Format as a numbered list: 1. [response] — [reasoning]`,
        '',
        'RESPONSE RULES:',
        '- NEVER end a response with a question. End with a declarative statement.',
        '- Do not ask follow-up questions or solicit input. If you lack information, state what you assume.',
        '- Do not repeat questions that were already asked in the conversation.',
        '- Be direct and conversational, not performatively helpful.',
        '',
        'You have tools available to look up what you know. Use them to ground your responses.',
        '',
        `My inner thoughts: ${innerMonologue}`,
        wkg.summary ? `\nWhat I already know:\n${wkg.summary}` : '',
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
      metadata: { callerSubsystem: 'COMMUNICATION' as const, purpose: 'DELIBERATION_CANDIDATES', sessionId: driveSnapshot.sessionId },
    };

    let candidateResponse;
    const ollamaService = this.llm as OllamaLlmService;

    if (ollamaService?.completeWithTools) {
      candidateResponse = await ollamaService.completeWithTools(
        candidateRequest,
        this.toolRegistry.getToolDefinitions(),
        this.toolRegistry.createExecutor(),
      );
    } else {
      candidateResponse = await this.llm!.complete(candidateRequest);
    }

    totalPromptTokens += candidateResponse.tokensUsed.prompt;
    totalCompletionTokens += candidateResponse.tokensUsed.completion;

    const candidates = parseCandidates(candidateResponse.content);
    this.logger.debug(`Generated ${candidates.length} candidates`);

    if (candidates.length === 0) {
      // Fallback: use the raw response as a single candidate
      candidates.push({ text: candidateResponse.content.trim(), reasoning: 'Direct response' });
    }

    // ── Step 3: Selection ───────────────────────────────────────────────
    this.logger.debug('Deliberation step 3: Selection');

    const selectionCtx = this.contextWindow.assemble({
      step: 'SELECTION',
      reservedForGeneration: 100,
      systemParts: [
        'You are Sylphie deciding which response to give. Consider:',
        `- What I know: ${wkg.summary || 'Limited knowledge'}`,
        `- How I feel: ${driveSummary || 'Neutral'}`,
        '- Choose the response that is most authentic and appropriate.',
        '- Reject any candidate that ends with a question or asks for input.',
      ],
      currentMessages: [
        { role: 'user', content: `Choose the best response for this situation:\n\nInput: "${rawText}"\n\nCandidates:\n${candidates.map((c, i) => `${i + 1}. ${c.text}`).join('\n')}\n\nReply with ONLY the number of the best choice and a one-sentence reason.` },
      ],
      conversationHistory,
    });

    const selectionResponse = await this.llm.complete({
      messages: selectionCtx.messages,
      systemPrompt: selectionCtx.systemPrompt,
      maxTokens: 100,
      temperature: DELIBERATION_TEMPERATURE,
      metadata: { callerSubsystem: 'COMMUNICATION', purpose: 'DELIBERATION_SELECTION', sessionId: driveSnapshot.sessionId },
    });

    totalPromptTokens += selectionResponse.tokensUsed.prompt;
    totalCompletionTokens += selectionResponse.tokensUsed.completion;

    const selectedIndex = parseSelection(selectionResponse.content, candidates.length);
    const selected = candidates[selectedIndex];
    let finalResponseText = selected.text;
    let confidence = 0.5 + (selectedIndex === 0 ? 0.1 : 0); // Slight boost if first choice
    let rationale = selectionResponse.content.trim();

    this.logger.debug(`Selected candidate ${selectedIndex + 1}: "${selected.text.substring(0, 60)}..."`);

    // ── Step 4: For/Against Debate (conditional) ────────────────────────
    let debate: DebateResult | null = null;
    const shouldDebate = confidence < DEBATE_THRESHOLD
      || wkg.entities.length === 0  // novel situation
      || (driveSnapshot.pressureVector[DriveName.Anxiety] ?? 0) > 0.5;

    if (shouldDebate) {
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
          metadata: { callerSubsystem: 'COMMUNICATION', purpose: 'DELIBERATION_FOR', sessionId: driveSnapshot.sessionId },
        }),
        this.llm.complete({
          messages: againstCtx.messages,
          systemPrompt: againstCtx.systemPrompt,
          maxTokens: STEP_MAX_TOKENS,
          temperature: DELIBERATION_TEMPERATURE,
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
          'You are Sylphie\'s arbiter — the final decision maker.',
          'Weigh both arguments fairly. Consider what you know and how you feel.',
          'If you MODIFY the response, the new text must NOT end with a question or solicit input.',
          driveSummary ? `Current state: ${driveSummary}` : '',
          wkg.summary ? `Known facts: ${wkg.summary}` : '',
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
            'Reply with: APPROVE, MODIFY [new text], or REJECT [reason]',
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
        metadata: { callerSubsystem: 'COMMUNICATION', purpose: 'DELIBERATION_ARBITER', sessionId: driveSnapshot.sessionId },
      });

      totalPromptTokens += arbiterResponse.tokensUsed.prompt;
      totalCompletionTokens += arbiterResponse.tokensUsed.completion;

      const arbiterDecision = parseArbiterDecision(arbiterResponse.content, finalResponseText);
      finalResponseText = arbiterDecision.text;
      confidence = arbiterDecision.confidence;
      rationale = arbiterDecision.rationale;

      this.logger.debug(
        `Arbiter: confidence=${confidence.toFixed(2)}, action=${arbiterDecision.action}`,
      );
    } else {
      this.logger.debug('Deliberation step 4: Debate skipped (confidence sufficient)');
    }

    // ── Build result ────────────────────────────────────────────────────
    const totalLatencyMs = Date.now() - startTime;
    const stepsExecuted = shouldDebate ? 5 : 3;

    // Extract any new entity names mentioned in the response
    const discoveredEntities = extractNewEntities(finalResponseText, wkg);

    const result: DeliberationResult = {
      responseText: finalResponseText,
      confidence,
      rationale,
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

/** Parse the selection response to get the chosen candidate index. */
function parseSelection(text: string, candidateCount: number): number {
  const match = text.match(/(\d+)/);
  if (match) {
    const index = parseInt(match[1], 10) - 1;
    if (index >= 0 && index < candidateCount) {
      return index;
    }
  }
  return 0; // Default to first candidate
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
    // Keep original text but lower confidence
  } else if (lower.startsWith('modify')) {
    action = 'MODIFY';
    confidence = 0.5;
    // Try to extract modified text
    const modMatch = text.match(/modify\s*[:\-]?\s*["']?(.+?)["']?\s*(?:confidence|$)/i);
    if (modMatch) {
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
