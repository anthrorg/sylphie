# 2026-03-29 — E4-T001: IPC Infrastructure Implementation

## Changes

- NEW: `src/drive-engine/ipc-channel/ipc-message-validator.ts` — Zod validation schemas for all inbound/outbound IPC messages (ACTION_OUTCOME, SOFTWARE_METRICS, SESSION_START/END, DRIVE_SNAPSHOT, OPPORTUNITY_CREATED, DRIVE_EVENT, HEALTH_STATUS)
- NEW: `src/drive-engine/ipc-channel/ipc-channel.service.ts` — Core IPC channel management: fork(), send queue (FIFO), message handlers, health tracking (spawn time, restart count)
- NEW: `src/drive-engine/ipc-channel/health-monitor.ts` — Periodic health checks, heartbeat timeout detection (>5s without DRIVE_SNAPSHOT = unhealthy), memory usage tracking
- NEW: `src/drive-engine/ipc-channel/recovery.ts` — Exponential backoff restart mechanism (1s, 2s, 4s, 8s, max 60s), max retry limit (3), in-flight message queue preservation
- NEW: `src/drive-engine/drive-process/main.ts` — Standalone child process entry point, IPC message handlers, health status responses, graceful shutdown
- MODIFIED: `src/drive-engine/drive-process/drive-process-manager.service.ts` — Real implementation using IpcChannelService, health monitor, recovery mechanism; wires DriveReaderService
- MODIFIED: `src/drive-engine/drive-reader.service.ts` — Added BehaviorSubject for snapshot state, updateSnapshot() method for DriveProcessManagerService to call

## Wiring Changes

- DriveProcessManagerService creates IpcChannelService, HealthMonitor, and RecoveryMechanism instances
- DriveProcessManagerService attaches handlers for DRIVE_SNAPSHOT → DriveReaderService.updateSnapshot()
- DriveReaderService exposes driveState$ Observable backed by BehaviorSubject
- Child process (main.ts) sends DRIVE_SNAPSHOT and HEALTH_STATUS, receives ACTION_OUTCOME/SOFTWARE_METRICS/SESSION_* messages

## Known Issues

- ActionOutcomeReporterService still a stub (implemented in E4-T002)
- Child process tick loop is a stub at 10Hz (implemented in T005)
- Drive rule evaluation is a stub (implemented in T005)
- Recovery mechanism is unused (will be wired in E4-T002)
- Memory tracking returns null (child process introspection from main is limited in Node.js)

## Gotchas for Next Session

- Child entry point is `dist/drive-engine/drive-process/main.js` (compiled from TypeScript). fork() path must resolve correctly at runtime.
- Zod validation on message boundary is strict — all payloads must exactly match schemas or are rejected with detailed error log
- Health monitor hooks into DRIVE_SNAPSHOT arrivals; early validation failures will cause health checks to fail
- In-flight message queue on IpcChannelService survives child crashes but messages are not persisted to disk (queued in memory only)
- Terminal/SIGTERM handlers in child process may be lost if parent is force-killed; graceful shutdown requires cooperative exit
