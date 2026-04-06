/**
 * Communication subsystem types.
 *
 * CANON §Subsystem 2 (Communication): Handles input parsing, response
 * delivery (TTS + Chatbox), person modeling (Other Evaluation), and event
 * logging. These types define the data flowing through the Communication
 * pipeline from input receipt through response delivery.
 *
 * CycleResponse is emitted by Decision Making at the end of each executor
 * cycle. Communication subscribes to this stream, assembles full context,
 * validates Theater Prohibition, delivers the response, and logs events.
 *
 * Dependencies: drive.types.ts, action.types.ts
 */

import type { DriveSnapshot } from './drive.types';
import type { ArbitrationResult } from './action.types';

// ---------------------------------------------------------------------------
// CycleResponse — Decision Making → Communication handoff
// ---------------------------------------------------------------------------

/**
 * Output of a completed decision cycle.
 *
 * Emitted by DecisionMakingService.response$ at the end of the LEARNING→IDLE
 * transition. Communication subscribes and uses this to generate the final
 * user-facing response.
 *
 * For SHRUG results, text is empty — Communication decides how to express
 * incomprehension based on the shrugDetail gap types.
 */
export interface CycleResponse {
  /** UUID for this response turn. Used for guardian feedback correlation. */
  readonly turnId: string;

  /** LLM-generated response text. Empty string for SHRUG. */
  readonly text: string;

  /** Which arbitration path produced this response. */
  readonly arbitrationType: 'TYPE_1' | 'TYPE_2' | 'SHRUG';

  /** Procedure node ID, 'SHRUG', or a synthetic Type 2 ID. */
  readonly actionId: string;

  /** Drive state at cycle start. Required for Theater Prohibition validation. */
  readonly driveSnapshot: DriveSnapshot;

  /** Full arbitration result for outcome reporting. */
  readonly arbitrationResult: ArbitrationResult;

  /** Total cycle latency in milliseconds (IDLE→...→IDLE). */
  readonly latencyMs: number;

  /** LLM model used, if Type 2 was invoked. */
  readonly model?: string;

  /** Token usage, if LLM was called. */
  readonly tokensUsed?: { readonly prompt: number; readonly completion: number };
}

// ---------------------------------------------------------------------------
// InputParseResult — Communication's input parsing output
// ---------------------------------------------------------------------------

/**
 * Result of Communication's Input Parser.
 *
 * Per the architecture diagram: raw text input → Input Parser → TimescaleDB.
 * The parser classifies the input type, extracts entities, and detects
 * guardian feedback before the text enters the sensory pipeline.
 */
export interface InputParseResult {
  /** Classification of the input. */
  readonly inputType:
    | 'GREETING'
    | 'QUESTION'
    | 'STATEMENT'
    | 'COMMAND'
    | 'EMOTIONAL_EXPRESSION'
    | 'GUARDIAN_FEEDBACK'
    | 'UNKNOWN';

  /** The original text content. */
  readonly content: string;

  /** Entities extracted from the input (names, topics, concepts). */
  readonly entities: readonly string[];

  /** Guardian feedback type detected from the input. */
  readonly guardianFeedbackType: 'confirmation' | 'correction' | 'none';

  /** Session identifier for event correlation. */
  readonly sessionId: string;

  /** When the input was parsed. */
  readonly parsedAt: Date;
}

// ---------------------------------------------------------------------------
// DeliveryPayload — Communication → Gateway handoff
// ---------------------------------------------------------------------------

/**
 * Payload delivered to the gateway for WebSocket transmission.
 *
 * Contains everything the frontend needs to render the response:
 * text, audio (if TTS available), metadata badges, and correlation IDs.
 */
export interface DeliveryPayload {
  /** WebSocket message type. Frontend expects 'cb_speech'. */
  readonly type: 'cb_speech';

  /** Response text to display in the chatbox. */
  readonly text: string;

  /** Turn ID for guardian feedback correlation. */
  readonly turnId: string;

  /** Base64-encoded TTS audio, if synthesized. */
  readonly audioBase64?: string;

  /** Audio MIME type (e.g., 'audio/mpeg'). */
  readonly audioFormat?: string;

  /** Whether the response passed Theater Prohibition validation. */
  readonly isGrounded: boolean;

  /** Which arbitration path produced this response. */
  readonly arbitrationType: 'TYPE_1' | 'TYPE_2' | 'SHRUG';

  /** Total cycle latency in milliseconds. */
  readonly latencyMs: number;

  /** Whether the LLM was called (Type 2). */
  readonly llmCalled: boolean;

  /** LLM cost in USD (0 for local Ollama). */
  readonly costUsd?: number;
}
