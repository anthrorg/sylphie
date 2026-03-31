/**
 * Conversation adapter — Sylphie-native ConversationOutgoingMessage → CoBeing_ConversationTurn.
 *
 * Translates the internal camelCase ConversationOutgoingMessage format into the
 * snake_case CoBeing_ConversationTurn shape expected by co-being React frontends
 * connecting with `?protocol=cobeing-v1`.
 *
 * This is a pure transformation layer. It carries no drive computation logic,
 * no provenance assignment, and no confidence ceiling enforcement. Values
 * originating from the WKG or Theater check are passed through unchanged;
 * only the shape and field names differ.
 *
 * Type mapping:
 * - 'response'                                    → 'cb_speech'
 * - 'system' && metadata.isThinking               → 'thinking'
 * - 'system' && metadata.error                    → 'error'
 * - 'system' (other)                              → 'system_status'
 * - 'drive-update'                                → null (skip; telemetry channel handles it)
 *
 * CANON §Theater Prohibition: is_grounded maps from theaterCheck.passed.
 * Absence of theaterCheck means no Theater Prohibition violation was detected,
 * so is_grounded defaults to true.
 *
 * CANON §Drive Isolation: This adapter is read-only. It reads from
 * ConversationOutgoingMessage and produces an output frame. It never writes
 * drive state.
 */

import type { ConversationOutgoingMessage } from '../interfaces/websocket.interfaces';
import type { CoBeing_ConversationTurn } from './cobeing-types';

/**
 * Adapt a Sylphie-native ConversationOutgoingMessage to the CoBeing_ConversationTurn
 * wire format.
 *
 * Returns null when the message type should be skipped for co-being clients.
 * Callers must check for null and discard the frame — do not send null frames
 * over the wire.
 *
 * turn_id is generated as `${msg.sessionId}-${turnCounter}`. The caller is
 * responsible for maintaining a monotonically increasing turnCounter per client
 * so that turns are globally orderable within a session.
 *
 * @param msg - The outgoing Sylphie message to adapt.
 * @param turnCounter - Monotonically increasing counter for this client's session.
 *   Incremented by the caller before each call so turn_ids are unique.
 * @returns A CoBeing_ConversationTurn ready to be serialised and sent over the
 *   wire, or null if the message type should not be forwarded on the conversation
 *   channel (e.g., drive-update messages, which travel on the telemetry channel).
 *
 * @example
 * const coBeingTurn = adaptConversationMessage(msg, ++this.clientTurnCounters.get(client));
 * if (coBeingTurn !== null) {
 *   await this.connectionManager.sendToClient(client, coBeingTurn);
 * }
 */
export function adaptConversationMessage(
  msg: ConversationOutgoingMessage,
  turnCounter: number,
): CoBeing_ConversationTurn | null {
  // drive-update messages travel on the telemetry channel; skip them here.
  if (msg.type === 'drive-update') {
    return null;
  }

  const turn_id = `${msg.sessionId}-${turnCounter}`;
  const timestamp = new Date().toISOString();

  // CANON §Theater Prohibition: is_grounded reflects theaterCheck.passed.
  // When theaterCheck is absent, no violation was detected — default to true.
  const is_grounded: boolean | null =
    msg.type === 'response' ? (msg.theaterCheck?.passed ?? true) : null;

  // grounding_ratio has no direct equivalent in ConversationOutgoingMessage.
  const grounding_ratio: number | null = null;

  if (msg.type === 'response') {
    return {
      type: 'cb_speech',
      turn_id,
      text: msg.text ?? '',
      timestamp,
      is_grounded,
      grounding_ratio,
      audioBase64: msg.audioBase64,
      audioFormat: msg.audioFormat,
    };
  }

  // msg.type === 'system' — branch on metadata flags.
  if (msg.type === 'system') {
    const metadata = msg.metadata;

    if (metadata?.['isThinking']) {
      return {
        type: 'thinking',
        turn_id,
        text: msg.text ?? '',
        timestamp,
        is_grounded: null,
        grounding_ratio: null,
      };
    }

    if (metadata?.['error']) {
      return {
        type: 'error',
        turn_id,
        text: typeof metadata['error'] === 'string' ? metadata['error'] : (msg.text ?? ''),
        timestamp,
        is_grounded: null,
        grounding_ratio: null,
      };
    }

    // Generic system status (e.g., session start/end, isThinking: false).
    return {
      type: 'system_status',
      turn_id,
      text: msg.text ?? '',
      timestamp,
      is_grounded: null,
      grounding_ratio: null,
    };
  }

  // TypeScript exhaustiveness guard — if a new msg.type is added to
  // ConversationOutgoingMessage without updating this adapter, the compiler
  // will flag the unreachable code and the runtime will return null safely.
  return null;
}
