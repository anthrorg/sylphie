# 2026-03-29 -- E8-T003 and E8-T004: OpportunityQueueService and PlanningRateLimiter

## Changes

- NEW: `src/planning/queue/opportunity-queue.service.ts` -- Full implementation of in-memory priority queue with:
  - Cold-start dampening based on decision count (0.8 at decision 0, decays to 0 by decision 100)
  - Exponential priority decay over time (per hour, configurable rate)
  - Queue eviction when max size is reached
  - Event emission for OPPORTUNITY_RECEIVED and OPPORTUNITY_DROPPED
  - Integration with DRIVE_STATE_READER for Theater Prohibition compliance

- NEW: `src/planning/rate-limiting/planning-rate-limiter.service.ts` -- Full implementation of dual-cap rate limiter:
  - Per-window plan creation cap (default 3 per 1-hour window)
  - Active-plans cap (default 10 concurrent unevaluated procedures)
  - Window expiration tracking with automatic reset
  - RateLimiterState reporting for dashboard display

## Wiring Changes

- Both services properly inject ConfigService to read PlanningConfig
- OpportunityQueueService additionally injects EVENTS_SERVICE and DRIVE_STATE_READER
- Both services use @Injectable() decorator for NestJS DI

## Known Issues

- Pre-existing type inference issue in `src/events/builders/event-builders.ts`:
  The `ExtractSubsystemEventType` utility type resolves to `never` for all subsystems
  because `EVENT_BOUNDARY_MAP` in `src/shared/types/event.types.ts` is not declared
  with `as const`. This causes a compile error on all `createPlanningEvent()` calls.
  Workaround: Implemented manual `buildPlanningEvent()` helper in OpportunityQueueService.

## Gotchas for Next Session

- The cold-start dampening in OpportunityQueueService uses synchronous cached decision count.
  The cache is refreshed asynchronously in the background (every 60s). If the system
  is brand new, the cache will be stale until the first refresh completes.

- PlanningRateLimiter window reset is checked on every canProceed() and getState() call.
  This is efficient for typical usage but could be optimized with an automatic timer
  if window tracking becomes a bottleneck.

- OpportunityQueueService.dequeue() re-applies cold-start dampening to all items.
  This means cold-start decay persists even as the system ages. This is intentional
  (per requirements) but could be surprising to observers.
