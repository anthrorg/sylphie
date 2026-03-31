# 2026-03-30 -- Implemented ConnectionManagerService (E9-T003)

## Changes
- MODIFIED: src/web/services/connection-manager.service.ts -- Replaced stub with full implementation including channel-based client tracking, broadcast/unicast messaging, heartbeat monitoring, and graceful shutdown

## Implementation Details
- Channel-based tracking: Map<string, Set<ClientMetadata>> with per-client connection metadata
- register/unregister: Add/remove clients from channels with automatic cleanup of empty channels
- broadcast: Send JSON-serialized messages to all clients on a channel, remove dead clients gracefully
- sendToClient: Promise-based unicast with configurable timeout (default 5000ms) using Promise.race pattern
- getConnectionCount/getChannels: Metrics for monitoring
- Heartbeat system: Starts on OnModuleInit, runs at configurable interval (default 30s), pings clients, detects stale connections (no pong within timeout), removes dead clients
- OnModuleDestroy: Closes all connections, clears channels, stops heartbeat
- Supports both Socket.io (.emit, .disconnect) and raw ws package (.send, .close) clients

## Wiring Changes
- Injected ConfigService to read wsHeartbeatIntervalMs from web.config
- Implements OnModuleInit and OnModuleDestroy NestJS lifecycle hooks

## Known Issues
- None identified; TypeScript passes with --noEmit

## Gotchas for Next Session
- Client metadata is mutable (lastPongAt) even though wrapper is readonly; necessary for heartbeat updates
- Heartbeat timeout is hardcoded to 1/2 of interval (could be made configurable if needed)
- Both Socket.io and ws patterns supported via duck typing; production verification may be needed
