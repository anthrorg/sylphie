/**
 * ContextWindowService — Token-aware context assembler for LLM calls.
 *
 * Every deliberation step has a finite token budget. This service assembles
 * the system prompt, conversation history, and current input into that budget
 * with priority-based truncation:
 *
 *   1. System prompt — always included (non-negotiable grounding)
 *   2. Current input messages — always included (the thing being responded to)
 *   3. Conversation history — filled most-recent-first until budget exhausted
 *   4. Generation reserve — tokens held back for the model's completion
 *
 * If the system prompt + current input alone exceed the budget, the system
 * prompt is truncated from the top (keeping the most critical lines at the
 * bottom, where persona rules and drive state live).
 *
 * Token estimation uses a character-based heuristic (~3.5 chars/token for
 * English text with the Llama tokenizer family). This is intentionally
 * conservative — underestimating tokens is worse than overestimating.
 *
 * CANON §Dual-Process Cognition: Type 2 deliberation is expensive. The context
 * window manager ensures each step uses tokens efficiently, leaving headroom
 * for the model to reason rather than stuffing the context to the brim.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LlmMessage } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for assembling a single LLM call's context. */
export interface ContextAssemblyRequest {
  /**
   * System prompt parts, joined with newline. Always included in full
   * unless the total budget is critically tight, in which case earlier
   * lines are dropped first (later lines carry persona + drive state).
   */
  readonly systemParts: readonly string[];

  /**
   * The current-turn messages that MUST appear at the end of the messages
   * array. These are never truncated — they are the input being responded to.
   */
  readonly currentMessages: readonly LlmMessage[];

  /**
   * Conversation history ordered chronologically (oldest first).
   * Filled from most recent backward until the token budget is exhausted.
   */
  readonly conversationHistory: readonly LlmMessage[];

  /**
   * Max tokens reserved for the model's generation (num_predict).
   * Subtracted from the total budget before allocating prompt space.
   */
  readonly reservedForGeneration: number;

  /**
   * Which deliberation step this is for (used for per-step budget lookup
   * and logging). If omitted, the default total budget is used.
   */
  readonly step?: DeliberationStep;
}

/** The assembled context ready to be passed to the LLM. */
export interface AssembledContext {
  /** Final system prompt string. */
  readonly systemPrompt: string;

  /** Messages array: trimmed history + current messages. */
  readonly messages: LlmMessage[];

  /** Number of history messages included (for logging/metrics). */
  readonly historyMessagesIncluded: number;

  /** Number of history messages that were dropped due to budget. */
  readonly historyMessagesDropped: number;

  /** Estimated total prompt tokens (system + all messages). */
  readonly estimatedPromptTokens: number;

  /** Whether the system prompt was truncated to fit. */
  readonly systemPromptTruncated: boolean;
}

/** Named deliberation steps for per-step budget configuration. */
export type DeliberationStep =
  | 'INNER_MONOLOGUE'
  | 'CANDIDATE_GENERATION'
  | 'SELECTION'
  | 'DEBATE_FOR'
  | 'DEBATE_AGAINST'
  | 'ARBITER';

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Approximate characters per token for the Llama tokenizer family.
 * Conservative estimate — real tokenizers vary between 3.2 and 4.0 chars/token
 * for English text. Using 3.5 means we slightly overcount tokens, which is
 * safer than undercounting (we'd rather include fewer messages than blow
 * past the context window).
 */
const CHARS_PER_TOKEN = 3.5;

/**
 * Overhead tokens per message for role markers and formatting.
 * Each message carries ~4 tokens of overhead (role tag, delimiters).
 */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Overhead tokens for the system prompt wrapper.
 */
const SYSTEM_PROMPT_OVERHEAD_TOKENS = 8;

// ---------------------------------------------------------------------------
// Default budgets
// ---------------------------------------------------------------------------

/** Default total context window budget if not configured. Llama 3.2 default. */
const DEFAULT_TOTAL_BUDGET = 8192;

/**
 * Per-step budget allocations as fractions of the total budget.
 * Steps that need more history get a larger share.
 */
const DEFAULT_STEP_FRACTIONS: Record<DeliberationStep, number> = {
  INNER_MONOLOGUE: 0.35,       // Needs context but generates short output
  CANDIDATE_GENERATION: 0.60,  // Richest step — needs full history for coherent responses
  SELECTION: 0.30,             // Mostly evaluating candidates, less history needed
  DEBATE_FOR: 0.30,            // Arguing about a specific response
  DEBATE_AGAINST: 0.30,        // Same as FOR
  ARBITER: 0.35,               // Weighs debate, needs some history for context
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ContextWindowService {
  private readonly logger = new Logger(ContextWindowService.name);

  /** Total model context window size in tokens. */
  private readonly totalBudget: number;

  /** Per-step token budgets (computed from total * fraction). */
  private readonly stepBudgets: Record<DeliberationStep, number>;

  constructor(private readonly config: ConfigService) {
    this.totalBudget = this.config.get<number>(
      'ollama.contextWindowTokens',
      DEFAULT_TOTAL_BUDGET,
    );

    // Compute per-step budgets from the total.
    this.stepBudgets = {} as Record<DeliberationStep, number>;
    for (const [step, fraction] of Object.entries(DEFAULT_STEP_FRACTIONS)) {
      this.stepBudgets[step as DeliberationStep] = Math.floor(
        this.totalBudget * fraction,
      );
    }

    this.logger.log(
      `Context window: totalBudget=${this.totalBudget} tokens, ` +
        `candidateGen=${this.stepBudgets.CANDIDATE_GENERATION}, ` +
        `monologue=${this.stepBudgets.INNER_MONOLOGUE}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Assemble a context window for an LLM call within the token budget.
   *
   * Priority order:
   * 1. Generation reserve (always subtracted first)
   * 2. System prompt (always included; truncated from top only if critical)
   * 3. Current messages (always included — the input being responded to)
   * 4. Conversation history (most recent first, until budget exhausted)
   */
  assemble(request: ContextAssemblyRequest): AssembledContext {
    const stepBudget = request.step
      ? this.stepBudgets[request.step]
      : this.totalBudget;

    // Available tokens = step budget - generation reserve.
    const promptBudget = stepBudget - request.reservedForGeneration;

    if (promptBudget <= 0) {
      this.logger.warn(
        `Step ${request.step ?? 'DEFAULT'}: generation reserve ` +
          `(${request.reservedForGeneration}) exceeds step budget (${stepBudget}). ` +
          `Returning minimal context.`,
      );
      return {
        systemPrompt: '',
        messages: request.currentMessages.map((m) => ({ role: m.role, content: m.content })),
        historyMessagesIncluded: 0,
        historyMessagesDropped: request.conversationHistory.length,
        estimatedPromptTokens: 0,
        systemPromptTruncated: true,
      };
    }

    // --- System prompt ---
    const fullSystemPrompt = request.systemParts.filter(Boolean).join('\n');
    let systemPrompt = fullSystemPrompt;
    let systemPromptTruncated = false;
    const systemTokens = this.estimateStringTokens(systemPrompt) + SYSTEM_PROMPT_OVERHEAD_TOKENS;

    // --- Current messages (non-negotiable) ---
    const currentTokens = this.estimateMessagesTokens(request.currentMessages);

    // Check if system + current already exceed budget.
    const fixedTokens = systemTokens + currentTokens;

    if (fixedTokens > promptBudget) {
      // Truncate system prompt from the top to make room.
      // Keep the bottom lines (persona, drive state, rules) which are most critical.
      const excessTokens = fixedTokens - promptBudget;
      systemPrompt = this.truncateFromTop(
        systemPrompt,
        this.estimateStringTokens(systemPrompt) - excessTokens,
      );
      systemPromptTruncated = true;

      this.logger.debug(
        `Step ${request.step ?? 'DEFAULT'}: system prompt truncated ` +
          `(${this.estimateStringTokens(fullSystemPrompt)} -> ${this.estimateStringTokens(systemPrompt)} tokens)`,
      );
    }

    // --- Conversation history (fill most-recent-first) ---
    const remainingBudget = promptBudget
      - (this.estimateStringTokens(systemPrompt) + SYSTEM_PROMPT_OVERHEAD_TOKENS)
      - currentTokens;

    const { included, dropped } = this.fitHistory(
      request.conversationHistory,
      Math.max(0, remainingBudget),
    );

    // --- Assemble final messages array: history (chronological) + current ---
    const messages: LlmMessage[] = [
      ...included,
      ...request.currentMessages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const estimatedPromptTokens =
      (this.estimateStringTokens(systemPrompt) + SYSTEM_PROMPT_OVERHEAD_TOKENS)
      + this.estimateMessagesTokens(messages);

    if (included.length > 0 || dropped > 0) {
      this.logger.debug(
        `Step ${request.step ?? 'DEFAULT'}: ` +
          `history=${included.length}/${included.length + dropped} msgs, ` +
          `~${estimatedPromptTokens} prompt tokens ` +
          `(budget=${promptBudget})`,
      );
    }

    return {
      systemPrompt,
      messages,
      historyMessagesIncluded: included.length,
      historyMessagesDropped: dropped,
      estimatedPromptTokens,
      systemPromptTruncated,
    };
  }

  /**
   * Estimate token count for a string.
   * Exposed for external callers that need to pre-check sizes.
   */
  estimateTokens(text: string): number {
    return this.estimateStringTokens(text);
  }

  /**
   * Get the configured total context window budget.
   */
  getTotalBudget(): number {
    return this.totalBudget;
  }

  /**
   * Get the per-step budget for a deliberation step.
   */
  getStepBudget(step: DeliberationStep): number {
    return this.stepBudgets[step];
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Estimate tokens for a raw string using char-based heuristic.
   */
  private estimateStringTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /**
   * Estimate tokens for an array of messages (content + overhead per message).
   */
  private estimateMessagesTokens(messages: readonly LlmMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.estimateStringTokens(msg.content) + MESSAGE_OVERHEAD_TOKENS;
    }
    return total;
  }

  /**
   * Fit conversation history into a token budget, prioritizing recent messages.
   *
   * Walks backward from the most recent message, accumulating tokens until
   * the budget is exhausted. Returns the included messages in chronological
   * order (oldest first) for proper conversation flow.
   *
   * Individual messages that exceed ~25% of the remaining budget are
   * mid-message truncated (keeping the end, which is more recent/relevant).
   */
  private fitHistory(
    history: readonly LlmMessage[],
    budgetTokens: number,
  ): { included: LlmMessage[]; dropped: number } {
    if (budgetTokens <= 0 || history.length === 0) {
      return { included: [], dropped: history.length };
    }

    const included: LlmMessage[] = [];
    let usedTokens = 0;
    const maxSingleMessageTokens = Math.max(
      MESSAGE_OVERHEAD_TOKENS + 10,
      Math.floor(budgetTokens * 0.25),
    );

    // Walk backward from most recent.
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      let msgTokens = this.estimateStringTokens(msg.content) + MESSAGE_OVERHEAD_TOKENS;

      if (msgTokens > maxSingleMessageTokens) {
        // Truncate long message — keep the end (more recent/relevant).
        const targetContentTokens = maxSingleMessageTokens - MESSAGE_OVERHEAD_TOKENS;
        const targetChars = Math.floor(targetContentTokens * CHARS_PER_TOKEN);
        const truncatedContent = '...' + msg.content.slice(-targetChars);
        msgTokens = this.estimateStringTokens(truncatedContent) + MESSAGE_OVERHEAD_TOKENS;

        if (usedTokens + msgTokens > budgetTokens) {
          break;
        }
        included.unshift({ role: msg.role, content: truncatedContent });
      } else if (usedTokens + msgTokens > budgetTokens) {
        // No room for this message — stop.
        break;
      } else {
        included.unshift({ role: msg.role, content: msg.content });
      }

      usedTokens += msgTokens;
    }

    const dropped = history.length - included.length;
    return { included, dropped };
  }

  /**
   * Truncate a string from the top (beginning) to fit within a target token count.
   * Preserves complete lines where possible. Prepends "[...truncated...]" marker.
   */
  private truncateFromTop(text: string, targetTokens: number): string {
    if (targetTokens <= 0) return '';

    const currentTokens = this.estimateStringTokens(text);
    if (currentTokens <= targetTokens) return text;

    const lines = text.split('\n');
    const result: string[] = [];
    let accumulatedTokens = 0;
    const markerTokens = 5; // "[...truncated...]" overhead
    const effectiveTarget = targetTokens - markerTokens;

    // Build from the bottom (most important lines are at the end).
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineTokens = this.estimateStringTokens(lines[i]) + 1; // +1 for newline
      if (accumulatedTokens + lineTokens > effectiveTarget) {
        break;
      }
      result.unshift(lines[i]);
      accumulatedTokens += lineTokens;
    }

    if (result.length < lines.length) {
      result.unshift('[...truncated...]');
    }

    return result.join('\n');
  }
}
