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

import { randomUUID } from 'node:crypto';

import { Injectable, Logger, Optional, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { LlmMessage } from '@sylphie/shared';
import { TimescaleService, verboseFor } from '@sylphie/shared';

const vlog = verboseFor('Communication');

/**
 * One-line JSON transcript event emitted to stdout per turn.
 * Always-on (not gated on VERBOSE) so it flows through Railway's log
 * stream and onward to any configured log drain (Axiom/Better Stack/etc.).
 * Filter expression: `evt:conversation_turn` (or `evt:conversation_session_start`).
 */
function emitTranscriptEvent(payload: Record<string, unknown>): void {
  // Direct stdout write keeps the line as pure JSON — no Nest log prefix to strip.
  process.stdout.write(JSON.stringify(payload) + '\n');
}

/**
 * Internal representation with answered state tracking.
 * User messages start as unanswered; when an assistant message is added,
 * all preceding unanswered user messages are marked answered.
 */
interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
  answered: boolean;
  addedAt: number;
}

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
export class ConversationHistoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConversationHistoryService.name);
  private readonly history: ConversationEntry[] = [];
  private schemaReady = false;

  /** Running estimate of total tokens in the buffer. */
  private estimatedTokens = 0;

  /** Session ID tagged onto every transcript event for this process lifetime. */
  private readonly sessionId = randomUUID();

  constructor(
    @Optional() @Inject(TimescaleService)
    private readonly timescale: TimescaleService | null,
  ) {}

  async onModuleInit(): Promise<void> {
    emitTranscriptEvent({
      evt: 'conversation_session_start',
      session_id: this.sessionId,
      ts: new Date().toISOString(),
    });

    if (!this.timescale) return;
    try {
      await this.timescale.query(`
        CREATE TABLE IF NOT EXISTS conversation_history (
          id SERIAL PRIMARY KEY,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          answered BOOLEAN NOT NULL DEFAULT false,
          added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      this.schemaReady = true;

      // Restore the most recent conversation (last 50 messages)
      const result = await this.timescale.query<{
        role: string; content: string; answered: boolean; added_at: Date;
      }>(`SELECT role, content, answered, added_at FROM conversation_history
          ORDER BY id DESC LIMIT ${MAX_MESSAGES}`);

      if (result.rows.length > 0) {
        // Rows come back newest-first, reverse to chronological order
        const rows = result.rows.reverse();
        for (const row of rows) {
          this.history.push({
            role: row.role as 'user' | 'assistant',
            content: row.content,
            answered: row.answered,
            addedAt: new Date(row.added_at).getTime(),
          });
          this.estimatedTokens += this.estimateMessageTokens(row.content);
        }
        this.logger.log(`Restored ${rows.length} conversation messages from previous session`);
      }
    } catch (err) {
      this.logger.warn(`Conversation history persistence init failed: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.timescale || !this.schemaReady || this.history.length === 0) return;
    try {
      // Truncate and re-write the current buffer — simpler than diffing
      await this.timescale.query('TRUNCATE conversation_history');
      for (const entry of this.history) {
        await this.timescale.query(
          `INSERT INTO conversation_history (role, content, answered, added_at)
           VALUES ($1, $2, $3, $4)`,
          [entry.role, entry.content, entry.answered, new Date(entry.addedAt).toISOString()],
        );
      }
      this.logger.log(`Saved ${this.history.length} conversation messages to TimescaleDB`);
    } catch (err) {
      this.logger.error(`Failed to save conversation history: ${(err as Error).message}`);
    }
  }

  /** Add a user message to the conversation history (starts as unanswered). */
  addUserMessage(text: string): void {
    const addedAt = Date.now();
    this.history.push({ role: 'user', content: text, answered: false, addedAt });
    this.estimatedTokens += this.estimateMessageTokens(text);
    this.trim();
    emitTranscriptEvent({
      evt: 'conversation_turn',
      session_id: this.sessionId,
      role: 'user',
      content: text,
      answered: false,
      ts: new Date(addedAt).toISOString(),
    });
    vlog('history: user message added', { length: text.length, historySize: this.history.length, estimatedTokens: this.estimatedTokens });
  }

  /**
   * Add an assistant (Sylphie) message to the conversation history.
   * Marks all preceding unanswered user messages as answered.
   */
  addAssistantMessage(text: string): void {
    // Mark all preceding unanswered user messages as answered —
    // this assistant message implicitly addresses them.
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i];
      if (entry.role === 'user' && !entry.answered) {
        entry.answered = true;
      }
      // Stop at the previous assistant message — everything before that
      // was already marked answered by an earlier response.
      if (entry.role === 'assistant') break;
    }

    const addedAt = Date.now();
    this.history.push({ role: 'assistant', content: text, answered: true, addedAt });
    this.estimatedTokens += this.estimateMessageTokens(text);
    this.trim();
    emitTranscriptEvent({
      evt: 'conversation_turn',
      session_id: this.sessionId,
      role: 'assistant',
      content: text,
      answered: true,
      ts: new Date(addedAt).toISOString(),
    });
    vlog('history: assistant message added', { length: text.length, historySize: this.history.length, estimatedTokens: this.estimatedTokens });
  }

  /** Get the current conversation history as a readonly array (no annotations). */
  getHistory(): readonly LlmMessage[] {
    return this.history.map(e => ({ role: e.role, content: e.content }));
  }

  /**
   * Split history into a compact summary of answered exchanges and only the
   * unanswered user messages as pending input.
   *
   * This structural separation ensures the LLM sees answered exchanges as
   * background context (in the system prompt) and only unanswered messages
   * as actual user turns requiring a response. Much more effective than
   * relying on [answered]/[unanswered] tags that smaller models ignore.
   */
  getSplitHistory(): { summary: string; pending: LlmMessage[] } {
    const summaryParts: string[] = [];
    const pending: LlmMessage[] = [];

    // Single forward pass (O(n)). An answered user message is paired with the
    // FIRST assistant message that follows it before the next user message —
    // exactly what the previous nested look-ahead computed, but without the
    // per-user forward rescan. `pendingAnswered` holds an answered user awaiting
    // its assistant: the next assistant pairs with it; a subsequent user before
    // any assistant flushes it as a bare line (no response found).
    let pendingAnswered: string | null = null;
    for (let i = 0; i < this.history.length; i++) {
      const entry = this.history[i];

      if (entry.role === 'user') {
        // A new user message ends the previous answered user's look-ahead window:
        // if no assistant was seen in between, the prior answered user had no
        // response → emit it as a bare summary line (matches the old `break`).
        if (pendingAnswered !== null) {
          summaryParts.push(pendingAnswered);
          pendingAnswered = null;
        }
        if (entry.answered) {
          // Answered user — start a look-ahead window for its assistant response.
          pendingAnswered = entry.content;
        } else {
          // Unanswered user message — goes into pending as a real user turn.
          pending.push({ role: 'user', content: entry.content });
        }
      } else {
        // Assistant message. It pairs with the awaiting answered user (if any);
        // an assistant with no awaiting answered user is skipped, exactly as the
        // old loop only consumed assistants via the per-user look-ahead.
        if (pendingAnswered !== null) {
          summaryParts.push(`${pendingAnswered} → ${entry.content}`);
          pendingAnswered = null;
        }
      }
    }
    // Trailing answered user with no following assistant → bare line.
    if (pendingAnswered !== null) {
      summaryParts.push(pendingAnswered);
    }

    const summary = summaryParts.length > 0
      ? 'Previous conversation:\n' + summaryParts.map((s, idx) => `${idx + 1}. ${s}`).join('\n')
      : '';

    return { summary, pending };
  }

  /**
   * Get conversation history with [answered]/[unanswered] annotations on user messages.
   * Used by the sensory pipeline so the LLM knows which messages still need a response.
   */
  getAnnotatedHistory(): readonly LlmMessage[] {
    return this.history.map(entry => ({
      role: entry.role,
      content: entry.role === 'user'
        ? `[${entry.answered ? 'answered' : 'unanswered'}] ${entry.content}`
        : entry.content,
    }));
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
