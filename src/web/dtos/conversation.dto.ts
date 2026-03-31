/**
 * Conversation and theater validation DTOs.
 *
 * CANON §Communication: These DTOs serialize conversation state
 * and theater validation results for the frontend and WebSocket clients.
 *
 * CANON §Theater Prohibition (Standard 1): Every response includes a
 * theater check result verifying that expressed emotion correlates with
 * actual drive state.
 */

import type { DriveSnapshotDto } from './drive.dto';

// ---------------------------------------------------------------------------
// Theater Validation DTOs
// ---------------------------------------------------------------------------

/**
 * TheaterViolationDto — a single Theater Prohibition violation.
 *
 * CANON Standard 1 (Theater Prohibition): Output must correlate with
 * actual drive state. A violation occurs when a response expresses a
 * drive state that does not match the current PressureVector.
 *
 * expressionType encodes directionality:
 * - 'pressure': response expresses an unmet need
 * - 'relief': response expresses satisfaction or ease
 *
 * Thresholds:
 * - pressure violation: drive < 0.2 (drive is too low to justify expressing need)
 * - relief violation: drive > 0.3 (drive is too high to justify expressing relief)
 */
export interface TheaterViolationDto {
  /**
   * Whether the expression is about unmet need or satisfaction.
   * - 'pressure': response claims to have a need
   * - 'relief': response claims to be satisfied
   */
  readonly expressionType: 'pressure' | 'relief';

  /** The drive whose expressed state contradicts the actual drive value. */
  readonly drive: string;

  /** Actual drive value at validation time. Range [-10.0, 1.0]. */
  readonly driveValue: number;

  /**
   * The threshold used for this violation check.
   * - 0.2 for pressure violations
   * - 0.3 for relief violations
   */
  readonly threshold: number;

  /** Human-readable description of the specific violation. */
  readonly description: string;
}

/**
 * TheaterCheckDto — result of Theater Prohibition validation.
 *
 * CANON Standard 1: Every generated response must pass this check
 * before delivery. The frontend uses this to understand whether the
 * response authentically reflects Sylphie's actual emotional state.
 *
 * overallCorrelation is a [0.0, 1.0] score representing how well the
 * response's expressed emotional register matches the drive state as a whole.
 * 1.0 = perfect correlation. 0.0 = complete mismatch.
 */
export interface TheaterCheckDto {
  /**
   * True if the response passes Theater Prohibition validation.
   * False if violations were detected.
   */
  readonly passed: boolean;

  /**
   * All violations detected.
   * Empty array when passed=true.
   * When passed=false, contains at least one violation.
   */
  readonly violations: readonly TheaterViolationDto[];

  /**
   * Overall drive-state correlation score in [0.0, 1.0].
   * Used for monitoring the LLM's expressive accuracy over time.
   * Not a gate — passed is the gate. This is the diagnostic metric.
   */
  readonly overallCorrelation: number;
}

// ---------------------------------------------------------------------------
// Conversation Messages
// ---------------------------------------------------------------------------

/**
 * ConversationMessage — a single message in a conversation.
 *
 * Represents either incoming input from the guardian or outgoing
 * response from Sylphie. Used in conversation history endpoints.
 *
 * CANON §Communication: Includes drive snapshot at response time and
 * theater validation result for transparency about response authenticity.
 */
export interface ConversationMessage {
  /** Unique message identifier. */
  readonly id: string;

  /** Message content (text or response). */
  readonly text: string;

  /**
   * Direction: who sent this message.
   * - 'incoming': from the guardian
   * - 'outgoing': from Sylphie
   */
  readonly direction: 'incoming' | 'outgoing';

  /** Wall-clock timestamp in milliseconds since epoch. */
  readonly timestamp: number;

  /** Drive snapshot at the time of outgoing response (optional). */
  readonly driveSnapshot?: DriveSnapshotDto;

  /**
   * Guardian feedback type if this is a feedback message (optional).
   * - 'correction': guardian is correcting Sylphie (3x drive weight)
   * - 'confirmation': guardian is confirming Sylphie (2x drive weight)
   * - 'none': not feedback
   */
  readonly guardianFeedbackType?: 'correction' | 'confirmation' | 'none';

  /** Theater validation result for this response (optional). */
  readonly theaterCheck?: TheaterCheckDto;

  /**
   * Whether this response was generated via Type 1 or Type 2.
   * - 'type1': graph reflex (fast, low-effort)
   * - 'type2': LLM-assisted (slow, high-effort)
   * - 'shrug': no confident response possible
   */
  readonly type1OrType2?: 'type1' | 'type2' | 'shrug';

  /** Input parse result details (optional). */
  readonly inputParseResult?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Conversation History
// ---------------------------------------------------------------------------

/**
 * ConversationHistoryResponse — paginated conversation history.
 *
 * Returned by GET /api/conversation/history?offset={o}&limit={l}.
 * Provides a chronologically-ordered view of the conversation transcript.
 *
 * CANON §Communication: Used by the frontend to display conversation
 * context and by Sylphie to ground response generation in prior turns.
 */
export interface ConversationHistoryResponse {
  /** Messages in chronological order, paginated. */
  readonly messages: readonly ConversationMessage[];

  /** Total message count across all pages. */
  readonly total: number;

  /** Pagination offset applied to this result. */
  readonly offset: number;

  /** Pagination limit applied to this result. */
  readonly limit: number;
}
