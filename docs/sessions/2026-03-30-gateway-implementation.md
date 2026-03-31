# 2026-03-30 — WebSocket Gateway Implementation (E9-T009, E9-T010, E9-T011)

## Changes

### NEW: TelemetryGateway (E9-T009)
- **File**: `src/web/gateways/telemetry.gateway.ts`
- Real-time drive state telemetry streaming via WebSocket
- Subscribes to `IDriveStateReader.driveState$` Observable (100Hz target)
- Per-client event buffering with configurable batch interval (500ms default) and batch size (50 events)
- Converts `DriveSnapshot` to `DriveSnapshotDto` for frontend consumption
- Channel: `'telemetry'`, Path: `/ws/telemetry`
- Proper cleanup of subscriptions and buffers on client disconnect

### NEW: GraphUpdatesGateway (E9-T010)
- **File**: `src/web/gateways/graph-updates.gateway.ts`
- Real-time WKG change notifications via WebSocket
- Polls `IEventService` for graph-related events (ENTITY_EXTRACTED, EDGE_REFINED, CONTRADICTION_DETECTED)
- Polling interval: 1000ms (2x telemetry batch interval for low-frequency updates)
- Maps events to `GraphUpdateFrame` with event type discrimination
- Supports future client subscription preferences via `@SubscribeMessage('subscribe')`
- Channel: `'graph'`, Path: `/ws/graph`

### NEW: ConversationGateway (E9-T011)
- **File**: `src/web/gateways/conversation.gateway.ts`
- Bidirectional real-time conversation via WebSocket
- Generates unique `sessionId` per client (UUID v4) for correlation
- Routes guardian input through `ICommunicationService` (CANON boundary respected)
- Sends responses with `DriveSnapshotDto` and drive state at response time
- Supports two message types:
  - `@SubscribeMessage('message')`: Guardian text input → CommunicationService → response
  - `@SubscribeMessage('feedback')`: Guardian feedback (correction/confirmation) with 3x/2x weighting info
- Theater Prohibition validation included in response metadata
- Channel: `'conversation:{sessionId}'`, Path: `/ws/conversation`
- Initial connection message includes system greeting and current drive state

## Wiring Changes

- All three gateways inject `IConnectionManagerService` via `CONNECTION_MANAGER` token
- TelemetryGateway: injects `IDriveStateReader` via `DRIVE_STATE_READER` token
- GraphUpdatesGateway: injects `IEventService` via `EVENTS_SERVICE` token
- ConversationGateway: injects `ICommunicationService`, `IDriveStateReader`, `IEventService` tokens
- All gateways respect `WebConfig` for buffering, polling, and timeouts
- Type-safe event and frame serialization via DTOs (DriveSnapshotDto, TelemetryFrame, GraphUpdateFrame, ConversationOutgoingMessage)

## Known Issues

- Graph update payloads are currently minimal (empty `GraphUpdatePayload`). Full implementation requires event type extensions to provide node/edge data
- Conversation gateway routes all responses through placeholder text; integration with actual `CommunicationService` response generation pending
- No metrics/logging for client connection duration or throughput yet

## Gotchas for Next Session

- Per-client state (subscriptions, buffers, sequence numbers) uses `Map<unknown, T>` — ensure clients maintain stable identity across reconnects if using connection pooling
- Buffering strategy drops old events when buffer exceeds max size; monitor for message loss on slow clients
- Graph polling runs independently per gateway tick; avoid thundering herd if many clients connect simultaneously
- Theater check metadata in conversation responses must be propagated from CommunicationService (currently placeholder)
- UUID import uses Node.js `crypto.randomUUID()` not `uuid` library (no external dependency)
