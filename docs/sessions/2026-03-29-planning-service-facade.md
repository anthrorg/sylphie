# 2026-03-29 — PlanningService (Public Facade) - E8-T012

## Changes
- MODIFIED: `src/planning/planning.service.ts` -- Replaced stub with full IPlanningService implementation
  - `processOpportunity(opportunity)` enqueues and immediately processes via background loop
  - `getOpportunityQueue()` returns queue snapshot sorted by priority
  - `getState()` returns operational metrics for dashboard display
  - `onModuleInit()` starts background processing loop with configurable interval (default 5000ms)
  - `onModuleDestroy()` gracefully shuts down, waits for in-flight processing to complete

## Wiring Changes
- PlanningService now injects: ConfigService, OPPORTUNITY_QUEUE, PLANNING_RATE_LIMITER, PLANNING_PIPELINE_SERVICE, DRIVE_STATE_READER
- Implements OnModuleInit and OnModuleDestroy for lifecycle management
- Background loop calls `pipeline.executePipeline()` for each dequeued opportunity
- Tracks processing state to prevent concurrent executions during shutdown

## Known Issues
- OpportunityQueueService.enqueue() signature mismatch: interface expects boolean return; implementation returns void
  - Temporary workaround: calling enqueue() without capturing return value
  - Should be addressed when OpportunityQueueService is completed
- PlanningPipelineService still a stub; returns empty result for now

## Gotchas for Next Session
- When PlanningPipelineService is implemented, ensure it never throws for expected exits (rate limiting, insufficient evidence) — only for infrastructure failures
- The background processing interval is non-blocking; immediate processOpportunity() call doesn't guarantee the opportunity is processed before return
- If queue.enqueue() is changed to return boolean, update processOpportunity() to handle rejection
