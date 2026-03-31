/**
 * WebSocket frame types for real-time communication.
 *
 * CANON §Subsystem Web: WebSocket is the real-time transport for telemetry,
 * graph updates, conversation flow, and drive state changes. All frames are
 * JSON-serializable and type-discriminated by the 'type' field.
 *
 * Frame types:
 * - TelemetryFrame: Event aggregates from TimescaleDB
 * - GraphUpdateFrame: WKG node/edge changes and confidence updates
 * - ConversationIncomingMessage: Guardian input or feedback
 * - ConversationOutgoingMessage: Sylphie's response and drive context
 * - DriveUpdateFrame: Drive state snapshot broadcasts
 */

import type { DriveSnapshotDto } from '../dtos/drive.dto';
import type { GraphNodeDto, GraphEdgeDto } from '../dtos/graph.dto';
import type { TheaterCheckDto } from '../dtos/conversation.dto';

// ---------------------------------------------------------------------------
// Telemetry Frame
// ---------------------------------------------------------------------------

/**
 * A single telemetry event within a TelemetryFrame batch.
 *
 * type is the event classification (event.types.ts EventType).
 * timestamp is wall-clock milliseconds since epoch (same as events table).
 * payload is the event-specific data (all event types serialize to Record<string, unknown>).
 */
export interface TelemetryEvent {
  /** Event type string from src/shared/types/event.types.ts. */
  readonly type: string;

  /** Event-specific data dictionary. */
  readonly payload: Record<string, unknown>;

  /** Wall-clock timestamp in milliseconds since epoch. */
  readonly timestamp: number;
}

/**
 * TelemetryFrame — batch of events for real-time telemetry streaming.
 *
 * Sent periodically (configurable via WebConfig.telemetryBatchIntervalMs)
 * or when the batch reaches maxBatchSize (WebConfig.telemetryMaxBatchSize).
 *
 * sequenceNumber is a monotonically increasing counter used by the frontend
 * to detect missing frames and reorder out-of-order arrivals.
 */
export interface TelemetryFrame {
  /** Literal string 'telemetry' — frame type discriminator. */
  readonly type: 'telemetry';

  /** Array of events collected in this batch. */
  readonly events: readonly TelemetryEvent[];

  /** Wall-clock timestamp in milliseconds when this frame was assembled. */
  readonly timestamp: number;

  /** Monotonically increasing sequence number for ordering and gap detection. */
  readonly sequenceNumber: number;
}

// ---------------------------------------------------------------------------
// Graph Update Frame
// ---------------------------------------------------------------------------

/**
 * Event type for graph updates — discriminated union of changes.
 *
 * CANON §Learning writes to the WKG: every update here corresponds
 * to a Knowledge module operation (node create/update, edge create/update,
 * confidence refinement).
 */
export type GraphUpdateEventType =
  | 'node-created'
  | 'node-updated'
  | 'edge-created'
  | 'edge-updated'
  | 'confidence-changed';

/**
 * Payload for a graph update — contains the modified node and/or edge.
 */
export interface GraphUpdatePayload {
  /** Node data if this update is a node change. */
  readonly node?: GraphNodeDto;

  /** Edge data if this update is an edge change. */
  readonly edge?: GraphEdgeDto;
}

/**
 * GraphUpdateFrame — notification of a WKG change.
 *
 * Sent whenever the Knowledge module writes a node or edge upsert,
 * or when confidence is refined on an existing node/edge.
 *
 * The frontend uses these to update the graph visualization in real time.
 */
export interface GraphUpdateFrame {
  /** Literal string 'graph-update' — frame type discriminator. */
  readonly type: 'graph-update';

  /** The kind of graph change that occurred. */
  readonly event: GraphUpdateEventType;

  /** The modified node and/or edge. */
  readonly payload: GraphUpdatePayload;

  /** Wall-clock timestamp in milliseconds when this change was committed. */
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Conversation Messages
// ---------------------------------------------------------------------------

/**
 * ConversationIncomingMessage — message from guardian (or feedback).
 *
 * CANON §Communication: Incoming message from the external gateway
 * carrying guardian input (typed or STT-transcribed) or explicit feedback
 * (correction/confirmation).
 */
export interface ConversationIncomingMessage {
  /** Literal string 'message' or 'feedback' — message type discriminator. */
  readonly type: 'message' | 'feedback';

  /** Session identifier for correlating with TimescaleDB session records. */
  readonly sessionId: string;

  /** The guardian's text input (present when type is 'message'). */
  readonly text?: string;

  /**
   * Feedback classification (present when type is 'feedback').
   * 'correction' — the guardian is correcting Sylphie (3x drive weight).
   * 'confirmation' — the guardian is confirming Sylphie (2x drive weight).
   */
  readonly feedbackType?: 'correction' | 'confirmation';

  /**
   * Reference to the message or response being corrected/confirmed.
   * Present when type is 'feedback'.
   */
  readonly targetMessageId?: string;
}

/**
 * ConversationOutgoingMessage — response from Sylphie.
 *
 * CANON §Communication: Outgoing response to the guardian carrying
 * generated text, theater validation result, and current drive state.
 *
 * CANON §Theater Prohibition: theaterCheck is required and must indicate
 * whether the response's expressed emotional register matches the drive state.
 */
export interface ConversationOutgoingMessage {
  /** Literal string 'response', 'drive-update', or 'system' — discriminator. */
  readonly type: 'response' | 'drive-update' | 'system';

  /** Session identifier for correlation. */
  readonly sessionId: string;

  /** Response text (present when type is 'response'). */
  readonly text?: string;

  /**
   * Theater Prohibition validation result for this response.
   * CANON Standard 1: Output must correlate with actual drive state.
   * Present when type is 'response'.
   */
  readonly theaterCheck?: TheaterCheckDto;

  /** Current drive snapshot at time of response generation. */
  readonly driveSnapshot?: DriveSnapshotDto;

  /**
   * Base64-encoded audio buffer for TTS playback in the browser.
   * Present only when TTS synthesis succeeded. Omitted on TTS failure
   * (graceful text-only degradation per CANON §Communication).
   * Decode with atob() or Buffer.from(audioBase64, 'base64') and play
   * via HTMLAudioElement with a data URL: 'data:audio/mp3;base64,...'
   */
  readonly audioBase64?: string;

  /**
   * Audio format for the encoded buffer. Always 'mp3' when present.
   * Tells the frontend which MIME type to use for the HTMLAudioElement.
   */
  readonly audioFormat?: string;

  /** Additional metadata (e.g., response intent type, latency metrics). */
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Drive Update Frame
// ---------------------------------------------------------------------------

/**
 * DriveUpdateFrame — broadcast of current drive state.
 *
 * Sent periodically by the Drive Engine and forwarded by the Web module
 * to all clients subscribing to the drive-updates channel. Allows the
 * frontend to display real-time drive pressure and trend indicators.
 */
export interface DriveUpdateFrame {
  /** Literal string 'drive-update' — frame type discriminator. */
  readonly type: 'drive-update';

  /** Current drive snapshot from the Drive Engine. */
  readonly drives: DriveSnapshotDto;

  /** Wall-clock timestamp in milliseconds when this snapshot was created. */
  readonly timestamp: number;
}
