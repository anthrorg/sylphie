# Ideas Research Report

**Generated:** 2026-04-09
**Last Updated:** 2026-04-09
**Scope:** All proposed ideas in `/wiki/ideas/`

---

## Executive Summary

Six proposed ideas were researched against the current Sylphie codebase. All six are feasible with varying levels of complexity and impact. Below is a prioritized summary followed by detailed findings for each idea.

| Idea | Feasibility | Effort | Risk | Priority |
|------|-------------|--------|------|----------|
| Concurrent Persistence Checks in Pipeline | HIGH | LOW (10-15 lines) | LOW | 1 - Quick Win |
| Configurable Persistence Check Weights | HIGH | LOW-MODERATE (2-4 days) | LOW | 2 - Quick Win |
| Planning Requeue Backoff on LLM Unavailability | HIGH | LOW (1-2 days) | LOW | 3 - Quick Win |
| Learning Pipeline Dead-Letter Tracking | HIGH | MODERATE (4-6 days) | LOW | 4 - High Value |
| Scope-Aware CALLS Edge Resolution | HIGH | MODERATE (17-25 hrs) | MEDIUM | 5 - Infrastructure |
| Decision Cycle Structured Error Recovery | HIGH | HIGH (16-20 hrs) | MEDIUM | 6 - Cross-Cutting |

**Note:** `batch-decision-event-flush.md` was empty and excluded from research.

---

## 1. Concurrent Persistence Checks in Pipeline

### Verdict: PROCEED - Quick Win

### Current State
- **File:** `perception-service/cobeing/layer2_perception/pipeline.py`, lines 474-482
- Sequential `for` loop awaits `find_match()` per confirmed track
- Each call crosses CANON A.5 boundary into Layer 3 (graph traversal + scoring)
- With 5 objects in scene at 3 fps, this consumes 5x single-check latency per 333ms frame budget

### Key Findings
- **find_match() is truly I/O-bound:** Single async call to `find_nodes_by_embedding()` plus lightweight local scoring (cosine similarity, spatial IoU, color Jaccard, size ratio, label match)
- **InMemoryGraphPersistence is safe for concurrent async reads:** Documented as "not thread-safe" but all concurrent reads via `asyncio.gather()` run in the same event loop, never preempted. Only reads from `_nodes` dict during concurrent calls
- **Pipeline already has full async infrastructure:** `asyncio.create_task()`, `asyncio.wait_for()`, `loop.run_in_executor()` all in use. Only missing pattern is `asyncio.gather()`
- **Feature extraction (lines 407-438) is CPU-bound and sequential** but already delegated to thread executor for detection/tracking. Lower priority for parallelization

### Recommended Implementation
```python
async def _check_one_track(self, track, preliminary_obs_map):
    obs = preliminary_obs_map.get(track.track_id)
    if obs is None:
        return track.track_id, None
    return track.track_id, await self._persistence_check.find_match(obs)

results = await asyncio.gather(
    *[self._check_one_track(t, preliminary_obs_map) for t in updated_confirmed],
    return_exceptions=True
)
persistence_results = {tid: r for tid, r in results if isinstance(r, PersistenceResult)}
```

### Risks
- **Layer 3 resource contention** with 10+ concurrent objects: mitigate with optional `asyncio.Semaphore`
- **Real Neo4j backend** may have different safety guarantees than InMemoryGraphPersistence: verify before production
- **Error handling changes:** With gather, one failing check doesn't halt others. Use `return_exceptions=True`

---

## 2. Planning Requeue Backoff on LLM Unavailability

### Verdict: PROCEED - Quick Win

### Current State
- **File:** `planning/src/planning.service.ts`, lines 398-402
- When constraint validation returns `deferred: true` (LLM unavailable), the opportunity is immediately re-enqueued via `this.queue.enqueue(opportunity)` with no delay or retry tracking
- **File:** `planning/src/pipeline/constraint-validation.service.ts`, lines 78-91
- Checks `this.llm.isAvailable()` before calling the LLM; returns `{ deferred: true }` when unavailable
- **File:** `planning/src/pipeline/proposal.service.ts`, lines 60-64
- Proposal stage falls back to template generation when LLM is unavailable (does not defer), so re-enqueue only happens at the validation stage
- Processing interval: `PROCESSING_INTERVAL_MS = 30_000` (30 seconds)
- Decay interval: `DECAY_INTERVAL_MS = 60_000` (60 seconds)

### Key Findings
- **Busy-loop confirmed:** When LLM is down, the same opportunity cycles through dequeue → research → simulation → proposal (template) → validation (defer) → re-enqueue every 30s tick. Research and simulation queries hit TimescaleDB each cycle, wasting I/O for a known-failing path
- **Re-enqueue resets decay clock:** `enqueue()` pushes the item back into the queue with its *current* `enqueuedAt` timestamp. However, the duplicate check in `enqueue()` (line 69-81) compares `contextFingerprint` — since the item was already dequeued, it won't be rejected as a duplicate. The item retains its original `enqueuedAt` so decay does still apply, but the item is never dropped because it keeps getting dequeued before the 60s decay sweep
- **No retry counter on QueuedOpportunity:** The `QueuedOpportunity` interface (planning.interfaces.ts:84-89) has only `payload`, `enqueuedAt`, `initialPriority`, and `currentPriority`. No `retryCount` or `retryAfter` field exists
- **Queue capacity starvation risk:** With `MAX_QUEUE_SIZE = 50` and `MAX_INGEST_PER_CYCLE = 10`, if multiple deferred items keep cycling, they occupy queue slots and can block newly arriving opportunities from being enqueued
- **Proposal stage is resilient:** `ProposalService` gracefully falls back to template-based proposals when LLM is down, so re-enqueue only comes from the validation stage. This means the backoff should specifically target validation deferral
- **No global LLM health check:** The system checks `llm.isAvailable()` per-call but has no mechanism to pre-check LLM status before dequeuing, meaning wasted research/simulation work occurs even when the LLM is known to be down

### Recommended Implementation

1. **Add backoff fields to `QueuedOpportunity`:**
```typescript
export interface QueuedOpportunity {
  readonly payload: OpportunityCreatedPayload;
  readonly enqueuedAt: Date;
  readonly initialPriority: number;
  currentPriority: number;
  /** Number of times this opportunity has been re-enqueued due to deferral. */
  retryCount?: number;
  /** Earliest time this opportunity should be dequeued again. */
  retryAfter?: Date;
}
```

2. **Update `dequeue()` in OpportunityQueueService** to skip items whose `retryAfter` is in the future:
```typescript
dequeue(): QueuedOpportunity | null {
  const now = Date.now();
  const idx = this.queue.findIndex(
    (item) => !item.retryAfter || item.retryAfter.getTime() <= now,
  );
  if (idx === -1) return null;
  const [item] = this.queue.splice(idx, 1);
  return item;
}
```

3. **Apply exponential backoff on re-enqueue** in `planning.service.ts`:
```typescript
if (validationResult.deferred) {
  const retryCount = (opportunity.retryCount ?? 0) + 1;
  const backoffMs = Math.min(
    30_000 * Math.pow(2, retryCount - 1),  // 30s, 60s, 120s, 240s...
    900_000,                                 // cap at 15 minutes
  );
  opportunity.retryCount = retryCount;
  opportunity.retryAfter = new Date(Date.now() + backoffMs);
  this.queue.enqueue(opportunity);
  this.logger.warn(
    `LLM unavailable -- deferring ${oppId} (retry #${retryCount}, next attempt in ${backoffMs / 1000}s)`,
  );
  return { wasNoop: false, opportunityId: oppId, stage: 'VALIDATION', procedureNodeId: null };
}
```

4. **Log backoff events** via the existing event logger for observability

### Answers to Open Questions
- **Per-opportunity vs global backoff:** Per-opportunity is the right call. A global pause would block GUARDIAN_TEACHING items which bypass rate limiting and should be processed immediately. Per-opportunity backoff naturally allows new, untried items to proceed
- **Maximum backoff cap:** 15 minutes (900s) is reasonable. With `DECAY_INTERVAL_MS = 60_000` and `DROP_THRESHOLD = 0.1`, a LOW-priority item (0.3) drops below threshold after ~11 minutes of decay. A 15-minute cap means a permanently-unavailable LLM causes items to naturally decay out rather than retry indefinitely
- **LLM health-check ping:** Not needed in v1. The per-opportunity backoff already reduces futile attempts. A global health-check could be a follow-up optimization if LLM outages are frequent
- **Re-enqueue and decay clock:** Re-enqueue preserves the original `enqueuedAt`, so decay continues to apply. The backoff window prevents the item from being dequeued during the wait, and decay will naturally drop it if the LLM stays down long enough. No special interaction to address

### Risks
- **Dequeue performance:** `findIndex` is O(n) on the queue, but with `MAX_QUEUE_SIZE = 50` this is negligible
- **Interface change:** Adding optional fields to `QueuedOpportunity` is backward-compatible since both new fields are optional
- **Clock skew:** `retryAfter` uses `Date.now()` which is monotonic enough for 30s+ granularity. Not a practical concern

---

## 3. Configurable Persistence Check Weights

### Verdict: PROCEED - Well-Defined Scope

### Current State
- **File:** `persistence-service/cobeing/layer2_perception/persistence_check_service.py`, lines 84-102
- Hardcoded module-level dicts: `_NEW_WEIGHTS` (spatial: 0.50, embedding: 0.25, color: 0.15, size: 0.05, label_raw: 0.05) and `_KNOWN_WEIGHTS` (embedding: 0.45, color: 0.25, spatial: 0.15, size: 0.10, label_raw: 0.05)
- Hardcoded thresholds: `_NEW_THRESHOLD = 5`, `_KNOWN_THRESHOLD = 10`
- Linear interpolation between profiles based on `confirmation_count` (5-10 frame transition)

### Key Findings
- **PersistenceCheckConfig already exists** in `config.py` (lines 186-252) as a Pydantic `BaseModel` with 6 fields. Adding weight profiles follows the established pattern exactly
- **Config is properly wired:** `PerceptionConfig` (BaseSettings) nests `PersistenceCheckConfig`, supports `COBEING_PERCEPTION_PERSISTENCE__*` env vars with `__` delimiter
- **Config injection is clean:** Created once at startup, passed to service via `__init__()`, stored as `self._config`
- **ObservationBuilder.debounce_iou_threshold** is already parameterizable at init time (default 0.95) but not wired to config. Pipeline hardcodes it at line 226
- **All other subsystem configs** (Camera, Detection, Tracking) follow the same Pydantic Field pattern with validators

### Recommended Implementation
1. Add `new_weights`, `known_weights`, `new_threshold`, `known_threshold`, `debounce_iou_threshold` fields to `PersistenceCheckConfig` with current values as defaults
2. Add Pydantic validators: weights non-negative and sum to 1.0, `known_threshold > new_threshold`
3. Refactor `_interpolate_weights()` to read from `self._config` instead of module globals
4. Wire `debounce_iou_threshold` from config to `ObservationBuilder.__init__()` in pipeline.py

### Risks
- **Invalid config could break matching:** Mitigate with strict Pydantic validators (sum-to-1.0, key validation)
- **Threshold ordering:** `new_threshold >= known_threshold` breaks interpolation. Add cross-field validation

---

## 4. Learning Pipeline Dead-Letter Tracking

### Verdict: PROCEED - High Operational Value

### Current State
- **File:** `learning/src/learning.service.ts`, lines 352-367
- `processEvent()` wraps 7-step pipeline in try-catch
- On failure: logs error, then marks event as learned anyway ("A broken event should not stall the pipeline")
- If `markAsLearned()` itself fails, silently continues
- Events are marked via `UPDATE events SET has_learned = true` in TimescaleDB

### Key Findings
- **Silent data loss is real:** Failed events are permanently skipped. Knowledge that should have been extracted never makes it into the WKG
- **No failure auditing:** No way to answer "how many events have we lost?" or "which pipeline step fails most?"
- **TimescaleDB patterns are established:** `CREATE TABLE IF NOT EXISTS` used in multiple services (conversation-reflection, update-wkg). Schema init via `ensureSchema()` in `OnModuleInit()`
- **Fire-and-forget pattern exists:** `LearningEventLogger` writes events async with `.catch()`. Dead-letter tracking can follow same pattern
- **7-step pipeline:** entity upsert, edge extraction, conversation entry, CAN_PRODUCE edges, edge refinement, mark-as-learned. Any step can fail
- **MAX_EVENTS_PER_CYCLE = 5** (CANON constraint). Dead-letter tracking doesn't change this

### Recommended Schema
```sql
CREATE TABLE IF NOT EXISTS learning_dead_letters (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  session_id TEXT NOT NULL,
  failure_reason TEXT NOT NULL,
  failure_context JSONB NOT NULL DEFAULT '{}',
  failed_at_step TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unreviewed',
  failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Recommended Flow
1. On processEvent() failure, call `recordDeadLetter(event, error, failedStep)` before marking as learned
2. Fire-and-forget pattern (consistent with LearningEventLogger)
3. Manual-only retry initially (safer; automatic retry for specific error types can be added later)
4. Monitor dead-letter table growth as a health metric

### Risks
- **Dead-letter INSERT could fail:** Fire-and-forget means no fallback. Monitor TimescaleDB health
- **Partial failure state:** If event fails mid-pipeline, some entities/edges may already be written. Retry could create duplicates. Mitigate with idempotent upserts (already in use)

---

## 5. Scope-Aware CALLS Edge Resolution

### Verdict: PROCEED - Infrastructure Improvement

### Current State
- **File:** `sylphie-pkg/src/sync/mutation-builder.ts`, lines 223-254
- `buildCallsEdges()` matches callees by `name` alone (or `.name` suffix)
- Cypher uses `LIMIT 1`, making resolution non-deterministic when multiple functions share a name
- No scope, import, or module information used in matching

### Key Findings
- **Import data is already extracted but unused:** `ParsedImport` captures `importedNames` and `moduleSpecifier`. IMPORTS edges are synced to Neo4j. But CALLS edges completely ignore this information
- **AST parser extracts bare identifiers:** `callees: string[]` in `ParsedFunction` contains names like `"process"`, `"Logger.warn"` with no source resolution
- **Import resolution exists but only in initial seed:** `resolveImportTarget()` in `initial-seed.ts` handles `@sylphie/*` workspace imports and relative imports. Not available in sync pipeline
- **IMPORTS edge has a bug:** Line 358 in mutation-builder.ts merges `(m)-[e:IMPORTS]->(m)` (self-referencing). Import targets aren't resolved during sync

### Recommended Approach
1. **Extend AST parser:** Add `CalleeInfo { name, resolvedPath?, source: 'local' | 'imported' | 'external' }` alongside existing `callees` array
2. **Create shared import resolver:** Extract `resolveImportTarget()` from initial-seed.ts to a utility module
3. **Update mutation-builder:** When `calleeFilePath` is available, match on `(filePath, name)` composite key. Fall back to name-only for unresolved callees. Mark edges with `resolved: true/false`
4. **Add integrity checks:** Count unresolved CALLS edges as a quality metric

### Risks
- **Relative import resolution** depends on current file path context. Use ts-morph Project API (already in ast-parser.ts)
- **Ambiguous callees:** If multiple modules export the same name and caller imports both, create edges to all candidates with `confidence: "partial"`
- **Performance:** Negligible; imports already computed, just need to traverse them during CALLS edge creation

---

## 6. Decision Cycle Structured Error Recovery

### Verdict: PROCEED - Phased Implementation Recommended

### Current State
- **File:** `decision-making/src/decision-making.service.ts`, lines 254-317, 342-901
- Tick cycle wraps `processInput` in try/catch that logs and swallows errors (line 313)
- `processInput` forces executor to IDLE on any error (line 896) then re-throws
- 8-state cycle: IDLE -> CATEGORIZING -> RETRIEVING -> PREDICTING -> ARBITRATING -> EXECUTING -> OBSERVING -> LEARNING -> IDLE

### Key Findings
- **Systematic error masking across services:**
  - `arbitration.service.ts`: Contradiction scanner returns `{ hasContradictions: false }` when Neo4j is unavailable. Caller can't distinguish "no contradictions" from "couldn't check"
  - `action-handler-registry.service.ts`: Every handler (LLM_GENERATE, WKG_QUERY) returns `null` on failure. Semantics of null are undefined (failure vs. empty result vs. not attempted)
  - `ollama-llm.service.ts`: Circuit breaker trips permanently after 5 consecutive failures. `available = false` has no automatic recovery. Only manual `resetCircuitBreaker()` restores service
  - `process-input.service.ts`: Action retrieval failures silently become empty candidate list

- **Strong but unused error infrastructure:** `SylphieException` hierarchy exists in `@sylphie/shared` with `DecisionMakingException` subclass. Zero instances are thrown in the decision-making package

- **Episode type has no error context:** Episodes encode experiences but have no `errorContext` field. Failed cycles are not encoded in episodic memory

### Recommended Phased Approach
1. **Phase 1 (Foundation):** Create `DecisionCycleError` subclass, define `ErrorRecoveryContext` type, emit `DECISION_CYCLE_ERROR` events to TimescaleDB via existing event logger
2. **Phase 2 (Handlers):** Extend `ActionStepHandler` return type to a union: `{ type: 'success'; data } | { type: 'failure'; error } | { type: 'unavailable'; reason }`. Update all four handlers
3. **Phase 3 (Circuit Breaker):** Implement exponential backoff recovery in OllamaLlmService. After 60s, permit one trial request. Extend backoff on failure, cap at 10 minutes
4. **Phase 4 (Episodic Memory):** Encode degraded cycles as special Episodes with error context for Learning subsystem visibility

### Risks
- **Circuit breaker permanent unavailability is the highest-risk item.** A single period of LLM instability blocks all Type 2 deliberation for the remainder of the session
- **Handler return type change is a breaking API change.** Requires updating executor and all downstream consumers
- **Cross-cutting concern:** Touches decision-making, shared, and learning packages. Needs careful coordination

---

## Cross-Cutting Observations

### Ideas That Complement Each Other
1. **Dead-Letter Tracking + Error Recovery:** The dead-letter table could store error-context episodes from decision-making failures. Both ideas reference this overlap in their open questions
2. **Concurrent Persistence Checks + Configurable Weights:** Both touch `persistence_check_service.py`. Implementing together avoids double-touching the same code
3. **Scope-Aware CALLS + Dead-Letter Tracking:** Both improve system observability and debuggability
4. **Planning Requeue Backoff + Error Recovery:** Both address the pattern of silent failure loops. The planning backoff is a targeted fix; the error recovery idea addresses the same class of problem across the decision-making cycle. Implementing backoff first provides a proven pattern to reference for the broader error recovery work

### Recommended Implementation Order
1. **Concurrent Persistence Checks** - smallest change, immediate performance benefit
2. **Configurable Persistence Check Weights** - small change, pairs with #1
3. **Planning Requeue Backoff on LLM Unavailability** - small change, prevents busy-loop waste during LLM outages
4. **Learning Pipeline Dead-Letter Tracking** - standalone, high operational value
5. **Scope-Aware CALLS Edge Resolution** - infrastructure improvement, no runtime dependencies
6. **Decision Cycle Structured Error Recovery** - largest scope, benefits from #3 and #4 being in place first
