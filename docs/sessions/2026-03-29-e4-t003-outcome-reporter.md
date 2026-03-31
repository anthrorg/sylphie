# 2026-03-29 -- E4-T003: ActionOutcomeReporterService fire-and-forget queue, IPC send

## Changes

- NEW: `src/drive-engine/action-outcome-reporter/outcome-queue.ts` -- FIFO queue implementation with async flushing, exponential backoff retry (3 max), and queue size management (1000 max). Uses setImmediate() for flush scheduling. Drops oldest messages if capacity exceeded.

- MODIFIED: `src/drive-engine/action-outcome-reporter.service.ts` -- Replaced stub with real implementation. Converts reportOutcome() params to ActionOutcomePayload, maps success:boolean → outcome:'positive'|'negative', maps ProvenanceSource → IPC feedbackSource format, constructs theaterCheck payload. reportMetrics() converts SoftwareMetrics to SoftwareMetricsPayload. Both methods are void fire-and-forget, enqueue via OutcomeQueue.

- MODIFIED: `src/drive-engine/drive-engine.module.ts` -- Added IpcChannelService to providers array so it can be injected into both DriveProcessManagerService and ActionOutcomeReporterService.

- MODIFIED: `src/drive-engine/drive-process/drive-process-manager.service.ts` -- Changed to inject IpcChannelService from NestJS DI instead of creating it manually. Maintains HealthMonitor and RecoveryMechanism.

## Wiring Changes

- IpcChannelService is now a singleton NestJS provider shared by DriveProcessManagerService and ActionOutcomeReporterService.
- OutcomeQueue receives a send function that dispatches messages via IpcChannelService. If send throws, queue retries with exponential backoff (10ms → 20ms → 40ms).
- ActionOutcomeReporterService initializes OutcomeQueue with the IPC send closure on construction.

## Known Issues

- theaterCheck driveValueAtExpression mapping: Currently uses correspondingDrive value directly. Theater Prohibition spec says "driveValueAtExpression" should be the actual drive value at time of expression. For 'none' expressions, we use the provided driveValue or 0. This may need adjustment when integrated with actual drive state snapshots.
- anxietyAtExecution hardcoded to 0: Should be captured from IDriveStateReader.getCurrentState() at time of action dispatch. Defer to Communication module integration.
- estimatedCostUsd hardcoded to 0: Should compute from token count and model pricing. Defer to infrastructure setup.
- windowStartAt/windowEndAt in SoftwareMetricsPayload: Currently both set to now. Caller should provide actual window boundaries. May refactor SoftwareMetrics interface to include these fields.

## Gotchas for Next Session

- OutcomeQueue.drainSync() is available for graceful shutdown — may need to hook this into DriveEngineModule's OnModuleDestroy.
- IpcChannelService.send() can throw; OutcomeQueue retries internally, but caller should not catch exceptions from reportOutcome() or reportMetrics() (they are void).
- Queue max size is 1000 and drops oldest messages — monitor for this warning in logs during high-load periods.
- FeedbackSource mapping assumes 'guardian_confirmation' for all GUARDIAN-sourced provenance. Context-aware 'guardian_correction' would require additional signal from caller (e.g., outcome flag).
