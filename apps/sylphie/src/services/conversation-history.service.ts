/**
 * ConversationHistoryService — Rolling buffer of conversation turns.
 *
 * Maintains an ordered list of user/assistant message pairs for the current
 * session. Fed into the sensory pipeline so the LLM_GENERATE handler can
 * include conversation history in its prompt.
 *
 * CANON §Communication: The LLM needs conversational context to generate
 * coherent multi-turn responses. Without history, each turn is isolated.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { LlmMessage } from '@sylphie/shared';

/** Maximum number of messages to retain (10 exchanges = 20 messages). */
const MAX_TURNS = 20;

@Injectable()
export class ConversationHistoryService {
  private readonly logger = new Logger(ConversationHistoryService.name);
  private readonly history: LlmMessage[] = [];

  /** Add a user message to the conversation history. */
  addUserMessage(text: string): void {
    this.history.push({ role: 'user', content: text });
    this.trim();
  }

  /** Add an assistant (Sylphie) message to the conversation history. */
  addAssistantMessage(text: string): void {
    this.history.push({ role: 'assistant', content: text });
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

  /** Clear all conversation history (e.g., on session reset). */
  clear(): void {
    this.history.length = 0;
    this.logger.debug('Conversation history cleared.');
  }

  /** Trim to MAX_TURNS, evicting oldest messages first. */
  private trim(): void {
    while (this.history.length > MAX_TURNS) {
      this.history.shift();
    }
  }
}
