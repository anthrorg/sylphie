/**
 * ConversationHistoryService — Token-aware rolling buffer of conversation turns.
 *
 * Maintains an ordered list of user/assistant message pairs for the current
 * session. Fed into the sensory pipeline so the deliberation pipeline can
 * include conversation history in its prompt via the ContextWindowService.
 *
 * The buffer uses a dual eviction strategy:
 *   - Hard cap on message count (MAX_MESSAGES) to prevent unbounded array growth
 *   - Soft cap on estimated token count (MAX_BUFFER_TOKENS) so short exchanges
 *     retain more turns and long messages don't waste slots
 *
 * The ContextWindowService handles per-step token budgeting at assembly time.
 * This service is the raw storage layer — it keeps as much history as is
 * reasonable, and the context assembler decides how much of it each LLM
 * call actually sees.
 *
 * CANON §Communication: The LLM needs conversational context to generate
 * coherent multi-turn responses. Without history, each turn is isolated.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { LlmMessage } from '@sylphie/shared';

/**
 * Hard cap on message count. Even with short messages, we don't keep
 * more than this many turns in memory. 50 messages = 25 exchanges.
 */
const MAX_MESSAGES = 50;

/**
 * Soft cap on estimated total tokens in the buffer. When the buffer
 * exceeds this, oldest messages are evicted until we're under budget.
 * Set to ~4K tokens — enough for rich multi-turn context but well
 * within the model's context window even before the ContextWindowService
 * applies its per-step budgets.
 */
const MAX_BUFFER_TOKENS = 4096;

/**
 * Approximate characters per token (matches ContextWindowService heuristic).
 */
const CHARS_PER_TOKEN = 3.5;

/**
 * Per-message overhead for role markers and formatting.
 */
const MESSAGE_OVERHEAD_TOKENS = 4;

@Injectable()
export class ConversationHistoryService {
  private readonly logger = new Logger(ConversationHistoryService.name);
  private readonly history: LlmMessage[] = [];

  /** Running estimate of total tokens in the buffer. */
  private estimatedTokens = 0;

  /** Add a user message to the conversation history. */
  addUserMessage(text: string): void {
    this.history.push({ role: 'user', content: text });
    this.estimatedTokens += this.estimateMessageTokens(text);
    this.trim();
  }

  /** Add an assistant (Sylphie) message to the conversation history. */
  addAssistantMessage(text: string): void {
    this.history.push({ role: 'assistant', content: text });
    this.estimatedTokens += this.estimateMessageTokens(text);
    this.trim();
  }

  /** Get the current conversation history as a readonly array. */
  getHistory(): readonly LlmMessage[] {
    return this.history;
  }

  /** Number of messages currently in the buffer. */
  get length(): number {
    return this.history.length;
  }

  /** Estimated total tokens across all buffered messages. */
  get tokenCount(): number {
    return this.estimatedTokens;
  }

  /** Clear all conversation history (e.g., on session reset). */
  clear(): void {
    this.history.length = 0;
    this.estimatedTokens = 0;
    this.logger.debug('Conversation history cleared.');
  }

  /**
   * Evict oldest messages until both caps are satisfied.
   * Message count cap is checked first (cheap), then token cap.
   */
  private trim(): void {
    // Hard cap: message count
    while (this.history.length > MAX_MESSAGES) {
      const evicted = this.history.shift();
      if (evicted) {
        this.estimatedTokens -= this.estimateMessageTokens(evicted.content);
      }
    }

    // Soft cap: total token budget
    while (this.estimatedTokens > MAX_BUFFER_TOKENS && this.history.length > 0) {
      const evicted = this.history.shift();
      if (evicted) {
        this.estimatedTokens -= this.estimateMessageTokens(evicted.content);
      }
    }

    // Guard against negative drift from estimation rounding.
    if (this.estimatedTokens < 0) {
      this.estimatedTokens = 0;
    }
  }

  /** Estimate tokens for a single message (content + overhead). */
  private estimateMessageTokens(content: string): number {
    return Math.ceil(content.length / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS;
  }
}
