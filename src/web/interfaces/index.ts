/**
 * Barrel export for all Web module interfaces and DI tokens.
 *
 * Centralizes interface and token imports for convenience.
 */

// DI Tokens
export { CONNECTION_MANAGER, WEB_CONFIG } from './web.tokens';

// Service Interfaces
export type { IConnectionManagerService, WebConfig } from './web.interfaces';

// WebSocket Frame Types
export type {
  TelemetryEvent,
  TelemetryFrame,
  GraphUpdateEventType,
  GraphUpdatePayload,
  GraphUpdateFrame,
  ConversationIncomingMessage,
  ConversationOutgoingMessage,
  DriveUpdateFrame,
} from './websocket.interfaces';

// Wire Protocol Negotiation
export type { WireProtocol } from './wire-protocol';
export { getWireProtocol } from './wire-protocol';
