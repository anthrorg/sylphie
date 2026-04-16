# Ideas Research Report

**Generated:** 2026-04-09
**Last Updated:** 2026-04-13
**Scope:** All proposed ideas in `/wiki/ideas/`

---

## Executive Summary

Forty-six proposed ideas were researched against the current Sylphie codebase (15 original + 29 new as of 2026-04-12 + 2 new as of 2026-04-13). Below is a prioritized summary followed by detailed findings for each idea.

### Original Ideas (2026-04-09)

| # | Idea | Feasibility | Effort | Risk | Priority |
|---|------|-------------|--------|------|----------|
| 1 | Concurrent Persistence Checks in Pipeline | HIGH | LOW (10-15 lines) | LOW | Quick Win |
| 2 | Configurable Persistence Check Weights | HIGH | LOW-MODERATE (2-4 days) | LOW | Quick Win |
| 3 | Planning Requeue Backoff on LLM Unavailability | HIGH | LOW (1-2 days) | LOW | Quick Win |
| 4 | Prediction Evaluator Memory Lifecycle | HIGH | LOW (1-2 days) | LOW | Quick Win |
| 5 | Opportunity Queue Eviction on Hard Cap | HIGH | LOW (~20 lines) | LOW | Quick Win |
| 6 | Inject Anxiety into Outcome Reporter | HIGH | LOW (1 day) | LOW | Quick Win — CANON Fix |
| 7 | Grounded Confidence for Reflection Insights | HIGH | LOW (1-2 days) | LOW | Quality Gate |
| 8 | Observation Validation Pipeline | HIGH | LOW-MODERATE (2-3 days) | LOW | Quality Gate |
| 9 | Deterministic Constraint Validation | HIGH | MODERATE (3-5 days) | MEDIUM | LLM Reduction |
| 10 | Deterministic Edge Refinement | HIGH | MODERATE (3-5 days) | LOW | LLM Reduction |
| 11 | Learning Pipeline Dead-Letter Tracking | HIGH | MODERATE (4-6 days) | LOW | High Value |
| 12 | Perception Thread-Safe State and Lazy Init | HIGH | LOW-MODERATE (2-3 days) | LOW | Reliability |
| 13 | Scope-Aware CALLS Edge Resolution | HIGH | MODERATE (17-25 hrs) | MEDIUM | Infrastructure |
| 14 | Rule-Based Cross-Modulation Engine | LOW — ALREADY EXISTS | N/A | N/A | No Action Needed |
| 15 | Decision Cycle Structured Error Recovery | HIGH | HIGH (16-20 hrs) | MEDIUM | Cross-Cutting |

**Note:** `batch-decision-event-flush.md` was empty and excluded from research.

### New Ideas (2026-04-12)

| # | Idea | Feasibility | Effort | Risk | Priority |
|---|------|-------------|--------|------|----------|
| 16 | Clean Up Stale Stub Comments in ActionHandlerRegistry | HIGH | LOW (1 day) | NONE | Documentation |
| 17 | Wire HALLUCINATED/DEPRESSIVE Attractor Detectors | ALREADY DONE | N/A | N/A | No Action Needed |
| 18 | Forward Drive Events to TimescaleDB | HIGH | MODERATE (2-3 days) | LOW | Integration |
| 19 | Implement DrivesController Stub Endpoints | HIGH | MODERATE (2-3 days) | MEDIUM | API Wiring |
| 20 | Wire IPCSelfKgReader for Real KG(Self) Access | HIGH | HIGH (5-7 days) | MEDIUM | Core Architecture |
| 21 | Support 'call' Step Type in MorphologyExecutor | HIGH | MODERATE (3-4 days) | MEDIUM | Feature |
| 22 | Remove SensoryLoggerService Temporary Stand-in | HIGH | MODERATE (2-3 days) | HIGH | Cleanup/Refactor |
| 23 | Simulation Cross-Drive Effect Aggregation | HIGH | MODERATE (3-4 days) | MEDIUM | Feature/Ranking |
| 24 | Implement Real Theater Prohibition Validation | HIGH | MODERATE (3-4 days) | MEDIUM | Validation |
| 25 | Add Timeout Guards to LLM Calls in Learning Pipeline | HIGH | LOW (1-2 days) | LOW | Quick Win |
| 26 | Per-Row Error Isolation in Planning Ingest | HIGH | LOW (1 day) | LOW | Quick Win |
| 27 | Add Jitter and Iterative Retry in Recovery Mechanism | HIGH | LOW (1-2 days) | LOW | Resilience |
| 28 | Adaptive Candidate Scoring Weights | HIGH | MODERATE (4-5 days) | MEDIUM | High Value |
| 29 | Perception Frame Source Timeout Guards | HIGH | LOW (1-2 days) | MEDIUM | Quick Win |
| 30 | Supervisor Verdict Audit Trail | HIGH | MODERATE (3-4 days) | LOW | High Value |
| 31 | Ungrounded Insight Re-grounding Sweep | HIGH | MODERATE (3-4 days) | LOW | Medium Value |
| 32 | Windowed Sampling for Long Session Reflection | HIGH | MODERATE (3-4 days) | MEDIUM | High Value |
| 33 | Learning Pipeline Neo4j Session Batching | HIGH | LOW (1-2 days) | LOW | Quick Win |
| 34 | Supervisor Adaptive Sampling Rate | HIGH | MODERATE (3-4 days) | LOW-MEDIUM | High Value |
| 35 | Decision Cycle Concurrency Guard | HIGH | HIGH (4-6 days) | HIGH | Critical Fix |
| 36 | Drive Tick-Loop Observability Instrumentation | HIGH | LOW-MODERATE (2-3 days) | LOW | Observability |
| 37 | Richer Semantic Extraction in Consolidation | NEEDS INFO | MODERATE-HIGH (4-6 days) | MEDIUM | High Value |
| 38 | Configurable LLM Pricing Rates in Cost Tracker | HIGH | LOW (< 1 day) | VERY LOW | Quick Win |
| 39 | Simulation Parallel Category Evaluation | HIGH | LOW (1-2 days) | LOW | Quick Win |
| 40 | Deduplicate Perception Embedding Init | BLOCKED | UNKNOWN | UNKNOWN | Blocked — File Not Found |
| 41 | Fix Guilt Repair Behavioral Change Dead Path | HIGH | MODERATE (2-3 days) | LOW | Critical Bug Fix |
| 42 | Live ageWeight Decay for Episodic Memory | HIGH | MODERATE (2-3 days) | MEDIUM | Correctness Critical |
| 43 | Bootstrap Category Normalization Consistency | HIGH | LOW (< 1 day) | LOW | Quick Win |
| 44 | Circuit Breaker for SidecarControlService | HIGH | MODERATE-HIGH (4-5 days) | MEDIUM | Production Resilience |

### New Ideas (2026-04-13)

| # | Idea | Feasibility | Effort | Risk | Priority |
|---|------|-------------|--------|------|----------|
| 45 | Pre-computed Assistant Pairing in getSplitHistory() | HIGH | LOW (< 1 day) | VERY LOW | Quick Win |
| 46 | Mood-Congruent Episodic Retrieval | HIGH | MODERATE (3-4 days) | MEDIUM | Intelligence Quality |

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

## 4. Prediction Evaluator Memory Lifecycle

### Verdict: PROCEED - Quick Win

### Current State
- **File:** `drive-engine/src/drive-process/prediction-evaluator.ts`, line 60
- `predictions: Map<string, PredictionRecord>` grows unboundedly over a session's lifetime
- Entries are added via `recordPrediction()` (line 110: `this.predictions.set(predictionId, record)`) but never individually removed
- Only cleanup is a `.clear()` call at session reset — which is not reliably invoked
- `predictionsByType` is properly windowed to `MAE_WINDOW_SIZE = 10` entries per type (line 117-122)

### Key Findings
- **Unbounded growth confirmed:** Every prediction ever recorded stays in the global `predictions` map indefinitely. The map is only used for `getDebugInfo()` (returning `this.predictions.size`) — individual entries are never queried after storage
- **Memory impact at scale:** At 1-10 predictions/second over a 60-minute session, the map accumulates 3,600-36,000 entries (~100 bytes each = 0.36-3.6 MB). Not catastrophic but unnecessary and grows linearly
- **OpportunityDetector.registry is self-healing:** Unlike the predictions map, the opportunity registry has decay-based removal (`consecutiveGoodPredictions >= 100` triggers deletion) and is bounded by `MAX_QUEUE_SIZE = 50`. No action needed here
- **Existing cleanup patterns available in codebase:**
  - `maeCache` in the same file uses TTL-based invalidation (`CACHE_TTL_MS = 60000`)
  - `RuleEngine` uses `setInterval()` for periodic reload (60s)
  - `RuleMatchCache` uses LRU eviction with max capacity
  - `OpportunityQueue` uses size-based caps
- **Tick loop hook point:** After the decay circuit (line 378-393 in `drive-engine.ts`) runs every 100 ticks — ideal location for periodic pruning

### Recommended Implementation
1. Add constants to `prediction-evaluation.ts`:
```typescript
export const PREDICTION_TTL_MS = 300_000;      // 5 minutes
export const PREDICTION_CLEANUP_INTERVAL = 600; // every 600 ticks (~10 minutes)
```

2. Add `pruneStale()` method to `PredictionEvaluator`:
```typescript
pruneStale(maxAgeMs: number = PREDICTION_TTL_MS): number {
  const cutoff = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const [id, record] of this.predictions) {
    if (record.recordedAt < cutoff) {
      this.predictions.delete(id);
      pruned++;
    }
  }
  return pruned;
}
```

3. Call `pruneStale()` periodically from the tick loop (every N ticks, alongside the decay circuit)

### Answers to Open Questions
- **Reasonable TTL:** 5 minutes. Outcomes that don't resolve within 5 minutes are likely orphaned. The `maeCache` already uses 60s TTL for a similar pattern
- **Time vs count based:** Both. TTL as primary (5 min), with a hard cap (e.g., 5000 entries) as safety net
- **Orphan telemetry:** Yes — log `pruned` count to vlog. A high orphan rate indicates upstream outcome reporting bugs
- **Cleanup frequency:** Every 600 ticks (~10 minutes at 1Hz). Low overhead since it's a simple map iteration

### Risks
- **Outcome arriving after TTL:** If an outcome arrives for a pruned prediction, it would fail silently. Since the global map is only used for debug info (not outcome resolution), this is a non-issue
- **Negligible overhead:** Map iteration at 5000 entries takes microseconds

---

## 5. Opportunity Queue Eviction on Hard Cap

### Verdict: PROCEED - Quick Win

### Current State
- **File:** `planning/src/queue/opportunity-queue.service.ts`, lines 97-105
- When `this.queue.length >= MAX_QUEUE_SIZE` (50), new opportunities are unconditionally rejected regardless of priority
- Queue is always sorted by `currentPriority` descending (line 200-202), so lowest-priority item is always at `queue[length-1]`

### Key Findings
- **Priority inversion confirmed:** A HIGH (1.0) or GUARDIAN_TEACHING (1.5) opportunity can be rejected while stale LOW (0.3) items that have partially decayed occupy queue slots
- **Drive Engine already implements this pattern:** `OpportunityQueue` in `drive-engine/src/drive-process/opportunity-queue.ts` (lines 34-48) enforces size limits by slicing: `this.opportunities = this.opportunities.slice(0, MAX_QUEUE_SIZE)` — keeping only top-N by priority. The Planning queue does not
- **Eviction comparison is O(1):** Since the queue is always sorted, `queue[queue.length - 1]` is always the lowest-priority item
- **GUARDIAN_TEACHING already bypasses rate limiting** (line 86) — could also bypass the hard cap entirely
- **Decay mechanism:** `applyDecay()` uses exponential decay (`initialPriority × e^(-0.1 × hoursElapsed)`) and drops items below `DROP_THRESHOLD = 0.1`. Eviction would complement decay by handling the case where the queue is full before decay has time to clean up

### Recommended Implementation
```typescript
// Replace unconditional rejection (lines 97-105) with:
if (this.queue.length >= MAX_QUEUE_SIZE) {
  const lowestItem = this.queue[this.queue.length - 1];
  if (opportunity.currentPriority <= lowestItem.currentPriority) {
    vlog('opportunity enqueue rejected — priority too low for full queue', {
      opportunityId: opportunity.payload.id,
      incomingPriority: opportunity.currentPriority,
      lowestQueuePriority: lowestItem.currentPriority,
    });
    return false;
  }
  // Evict lowest-priority item
  const evicted = this.queue.pop()!;
  vlog('opportunity evicted from queue', {
    evictedId: evicted.payload.id,
    evictedPriority: evicted.currentPriority,
    replacedById: opportunity.payload.id,
    replacedByPriority: opportunity.currentPriority,
  });
}

this.queue.push(opportunity);
this.sortQueue();
return true;
```

### Answers to Open Questions
- **Eviction threshold:** No minimum threshold needed. If the newcomer has higher priority than the lowest item, eviction is justified. Decay already handles items below 0.1
- **Distinct event:** Yes — log as `OPPORTUNITY_EVICTED` with both IDs for analytics
- **GUARDIAN_TEACHING bypass:** Consider bypassing hard cap entirely for GUARDIAN_TEACHING (priority 1.5). Since it already bypasses rate limiting, bypassing the cap is consistent. Would temporarily allow queue to exceed MAX_QUEUE_SIZE by 1

### Risks
- **Queue size guarantee:** If GUARDIAN_TEACHING bypasses the cap, max size becomes 51 temporarily. Acceptable
- **Eviction cascading:** Not possible — each enqueue can evict at most one item

---

## 6. Inject Anxiety into Outcome Reporter

### Verdict: PROCEED - Quick Win / CANON Compliance Fix

### Current State
- **File:** `drive-engine/src/action-outcome-reporter.service.ts`, line 117-118
- `anxietyAtExecution: 0` is hardcoded with a TODO comment: "This should come from current drive state at time of execution"
- Three other call sites correctly read `driveSnapshot.pressureVector[DriveName.Anxiety]`: `communication.service.ts` lines 557 and 832, `decision-making.service.ts` line 640

### Key Findings
- **CANON §A.15 violation confirmed:** The Anxiety Amplification behavioral contingency (at `drive-process/behavioral-contingencies/anxiety-amplification.ts`) checks `anxietyAtExecution > 0.7` and applies a 1.5x confidence reduction multiplier on negative outcomes. Since the reporter always sends 0, outcomes routed through this path **never trigger anxiety amplification**, silently undermining the contingency system
- **DriveStateAccessor is injectable:** `DriveReaderService` is available via `DRIVE_STATE_READER` injection token. It provides `getCurrentState()` which returns a defensive copy of the latest drive snapshot. Staleness is 1-2 ticks (~10-20ms at 100Hz) — acceptable for anxiety values which change slowly
- **Drive Isolation tension is manageable:** The reporter is currently "sole write path with no read dependency on drive state." Adding a read dependency via `DRIVE_STATE_READER` is read-only — it does not write to drives or evaluation functions, so CANON Standard 6 (No Self-Modification of Evaluation) is preserved
- **Dead ternary at lines 96-99:** Both branches evaluate identically (`outcome.theaterCheck.driveValue ?? 0`). Unfinished refactor — should be collapsed or completed
- **Additional hardcodes:** `estimatedCostUsd: 0` (should compute from token count + model pricing) and `windowStartAt`/`windowEndAt` both set to `now` (should receive actual boundaries from caller)

### Recommended Implementation
1. **Inject `DRIVE_STATE_READER` into `ActionOutcomeReporterService`:**
```typescript
constructor(
  @Inject(DRIVE_STATE_READER) private readonly driveReader: IDriveStateReader,
  // ... existing deps
) {}
```

2. **Read anxiety in `reportOutcome()`:**
```typescript
const driveSnapshot = this.driveReader.getCurrentState();
const anxietyAtExecution = driveSnapshot.pressureVector[DriveName.Anxiety] ?? 0;
```

3. **Fix dead ternary** (lines 96-99): Collapse to single assignment or implement intended branch logic
4. **Defer `estimatedCostUsd` and window boundaries** to separate tickets — they're valuable but independent

### Risks
- **Dependency edge:** Adding `DRIVE_STATE_READER` creates a read dependency from reporter → drive state. This is architecturally sound (read-only, no evaluation modification) but should be documented
- **Staleness:** Snapshot is 1-2 ticks behind. For anxiety (which changes slowly relative to tick rate), this is negligible

---

## 7. Grounded Confidence for Reflection Insights

### Verdict: PROCEED - Quality Gate

### Current State
- **File:** `learning/src/pipeline/conversation-reflection.service.ts`, lines 431-522
- `persistInsight()` creates Insight nodes with fixed `REFLECTION_CONFIDENCE = 0.30` and `INFERENCE` provenance
- For each `referencedEntities` entry, attempts to create a REVEALS edge via case-insensitive label match in Neo4j
- When entity labels don't match anything in the WKG, the MATCH silently returns zero rows — no edge is created, no error logged, no confidence adjustment

### Key Findings
- **Silent grounding failure confirmed:** An LLM hallucination referencing entities never extracted (e.g., "Jim mentioned he loves Haskell" when "Haskell" was never upserted) gets the same 0.30 confidence as a well-grounded insight connecting three known entities. The `edgesCreated` counter tracks success but doesn't feed back into the Insight node's confidence
- **Insight nodes are currently unused downstream:** ActionRetrieverService only queries ActionProcedure nodes (filtered by `confidence >= 0.50`). WkgContextService queries entities and relationships but never Insight nodes. No drive modulation references Insights. They form a read-only archive
- **However, this is forward-looking infrastructure:** When Insights are eventually consumed (e.g., by retrieval or planning), the grounding signal will be critical for filtering hallucinated knowledge
- **CANON Standard 3 (Confidence Ceiling) interaction:** Insights at 0.30 are already below the 0.60 ceiling. The grounding adjustment would push ungrounded insights lower (e.g., 0.10) and could push well-grounded ones higher (up to 0.30 × 1.0 = 0.30 — no change for fully grounded). To be truly useful, grounding could increase base confidence for fully-grounded insights (e.g., 0.35) while penalizing ungrounded ones
- **Implementation is straightforward:** The REVEALS edge creation loop (lines 481-507) already tracks `edgesCreated` and could compute `groundingRatio = edgesCreated / referencedEntities.length`, then adjust: `confidence = REFLECTION_CONFIDENCE * groundingRatio`

### Recommended Implementation
```typescript
// After the REVEALS edge loop (line 507):
const totalRefs = insight.referencedEntities.length;
if (totalRefs > 0) {
  const groundingRatio = edgesCreated / totalRefs;
  const adjustedConfidence = Math.max(0.10, REFLECTION_CONFIDENCE * groundingRatio);

  // Update Insight node confidence
  await session.run(
    `MATCH (i:Insight {node_id: $insightId})
     SET i.confidence = $confidence, i.grounded = $grounded`,
    {
      insightId,
      confidence: adjustedConfidence,
      grounded: edgesCreated > 0,
    },
  );
}
```

### Answers to Open Questions
- **Drop fully ungrounded insights?** No — store them at minimum confidence (0.10) with `grounded: false`. They may become groundable later as new entities are extracted
- **Linear scaling vs floor:** Linear with a minimum floor of 0.10. `confidence = max(0.10, 0.30 × ratio)` gives: 0/3 matched → 0.10, 1/3 → 0.10, 2/3 → 0.20, 3/3 → 0.30
- **Edge write success:** Yes — factor in whether the REVEALS edge was actually created, not just whether the entity was found. The current `edgesCreated` counter already handles this

### Risks
- **Extra Neo4j write:** One additional `SET` per insight. Negligible overhead given reflection runs infrequently
- **Future retrieval integration needed:** The grounding signal only matters once Insights are consumed by retrieval/planning. This is infrastructure prep

---

## 8. Observation Validation Pipeline

### Verdict: PROCEED - Quality Gate

### Current State
- **File:** `perception-service/cobeing/layer2_perception/pipeline.py`, lines 486-492
- Observations are built by `ObservationBuilder.build()` and immediately extended into `self._observations` with no quality gate
- **Existing validation is limited to:**
  - Pydantic model validators on BoundingBox (x_min < x_max, y_min < y_max, non-zero area)
  - Detection confidence range [0.0, 1.0] via Field constraint
  - Debounce filtering (IoU threshold check against previous emission)
- **No validation exists for:** minimum bounding box dimensions, embedding norm thresholds, area fraction bounds, track age requirements, aspect ratio extremes

### Key Findings
- **Observation fields available for validation:** `confidence` (float 0-1), `bounding_box` (normalized coords with `area_fraction` computed property), `embedding` (list[float] | None), `dominant_colors`, `label_raw`, `provenance`
- **Config pattern is well-established:** `config.py` uses Pydantic `BaseModel` subclasses nested under `PerceptionConfig(BaseSettings)` with env var support (`COBEING_PERCEPTION_*`). Adding `ValidationConfig` follows existing DetectionConfig/TrackingConfig pattern exactly
- **Insertion point is clean:** Between `builder.build()` (line 486) and `self._observations.extend()` (line 492) — a one-line filter or validator call
- **Layer 3 (observation_ingestion.py) has no input quality checks** — it accepts whatever observations arrive and creates ObjectInstance nodes. Junk observations propagate directly into the WKG
- **Persistence matching already handles some edge cases defensively:** `_score_embedding()` returns 0.0 for zero-magnitude embeddings, `_score_spatial()` catches KeyError/TypeError/ValueError. But these are post-ingestion workarounds, not pre-ingestion quality gates

### Recommended Implementation
```python
class ValidationConfig(BaseModel):
    """Observation validation thresholds between Layer 2 and Layer 3."""
    min_bbox_area_fraction: float = Field(default=0.001, gt=0.0, le=1.0)
    max_bbox_area_fraction: float = Field(default=0.95, gt=0.0, le=1.0)
    min_confidence: float = Field(default=0.25, ge=0.0, le=1.0)
    min_embedding_norm: float = Field(default=0.1, ge=0.0)
    reject_zero_embeddings: bool = Field(default=True)
    log_rejections: bool = Field(default=True)

def validate_observation(obs: Observation, config: ValidationConfig) -> bool:
    if obs.bounding_box.area_fraction < config.min_bbox_area_fraction:
        return False
    if obs.bounding_box.area_fraction > config.max_bbox_area_fraction:
        return False
    if obs.confidence < config.min_confidence:
        return False
    if config.reject_zero_embeddings and obs.embedding is not None:
        norm = sum(x*x for x in obs.embedding) ** 0.5
        if norm < config.min_embedding_norm:
            return False
    return True
```

Insert in pipeline.py:
```python
new_observations = builder.build(...)
validated = [obs for obs in new_observations if validate_observation(obs, self._config.validation)]
self._observations.extend(validated)
```

### Answers to Open Questions
- **Silent drop vs logging:** Log rejections with vlog for diagnostics (count per frame, rejection reason). Don't raise errors
- **Hard gate vs soft score:** Hard gate for v1. A quality score adds complexity without clear consumer. Can evolve later
- **Min bbox area fraction:** 0.001 (0.1% of frame area) is a reasonable starting default — catches sub-pixel noise. Tunable via config
- **Validate feature profiles:** Yes — reject zero-norm embeddings. Trust extractors for non-zero values

### Risks
- **Over-filtering:** Aggressive thresholds could reject valid small objects. Mitigate with configurable thresholds and rejection logging
- **Config tuning:** Defaults must be conservative (reject only obvious junk). Empirical tuning needed per camera setup

---

## 9. Deterministic Constraint Validation

### Verdict: PROCEED - LLM Cost Reduction

### Current State
- **File:** `planning/src/pipeline/constraint-validation.service.ts`, lines 73-166
- Uses `tier: 'deep'` LLM call (most expensive) with `temperature: 0.1` (near-deterministic) and `maxTokens: 512`
- Checks 5 constraints: no procedure conflict, addresses opportunity, executable steps, no theater, contingency tracing
- Retry loop: up to `MAX_RETRIES = 3` attempts, each failed attempt triggers a `tier: 'medium'` refinement call
- Worst case: 3 deep calls + 2 medium calls per validation

### Key Findings
- **Constraints 1-3 are fully deterministic:**
  1. **Procedure conflict:** Can query WKG for existing `ActionProcedure` nodes by `category` and compare `trigger_context` fingerprints. Currently the LLM reasons about this without explicit WKG queries
  2. **Addresses opportunity:** Structural check: `proposal.triggerContext.includes(opportunity.payload.classification)` or `proposal.rationale.includes(opportunity.payload.affectedDrive)`
  3. **Executable steps:** Set-membership: `stepType ∈ {'LLM_GENERATE', 'WKG_QUERY', 'EMIT_EVENT'}`
- **Constraints 4-5 are partially deterministic:**
  4. **No theater (CANON Standard 1):** Can check that `proposal.predictedDriveEffects` is non-empty and at least one action step references an observable outcome. Edge cases may need LLM judgment
  5. **Contingency tracing (CANON Standard 2):** Can verify `params` include observable outcome fields. Structural check is feasible for common cases
- **Deferred behavior becomes unnecessary:** With deterministic rules, validation is always available. The `deferred: true` path (which causes busy-loop requeue — see idea #2) would only be needed if an optional LLM fallback is kept for edge cases
- **Refinement loop simplifies:** Deterministic validation either passes or fails with specific violations. No need to "ask the LLM to try again" — violations are structural and must be fixed by the proposal generator
- **ValidationResult interface** (planning.interfaces.ts lines 201-208) is already well-structured: `{ passed, reasoning, violations[], attemptsUsed, deferred }`

### Recommended Implementation
```typescript
function validateConstraints(
  proposal: PlanProposal,
  opportunity: QueuedOpportunity,
  existingProcedures: ActionProcedureNode[],
): ValidationResult {
  const violations: string[] = [];

  // Constraint 3: valid step types
  const VALID_STEP_TYPES = new Set(['LLM_GENERATE', 'WKG_QUERY', 'EMIT_EVENT']);
  for (const step of proposal.actionSequence) {
    if (!VALID_STEP_TYPES.has(step.stepType)) {
      violations.push(`invalid_step_type: ${step.stepType}`);
    }
  }

  // Constraint 2: addresses opportunity
  const opp = opportunity.payload;
  const addressesOpp =
    proposal.triggerContext.includes(opp.classification) ||
    proposal.rationale.includes(opp.affectedDrive);
  if (!addressesOpp) violations.push('plan_does_not_address_opportunity');

  // Constraint 1: no procedure conflict
  const conflicting = existingProcedures.filter(
    (p) => p.category === proposal.category &&
           p.trigger_context === proposal.triggerContext
  );
  if (conflicting.length > 0) violations.push('conflicts_with_existing_procedure');

  // Constraint 4: no theater (drive effect required)
  const hasDriveEffect = Object.keys(proposal.predictedDriveEffects).length > 0;
  if (!hasDriveEffect) violations.push('no_drive_effect_theatrical');

  // Constraint 5: contingency tracing (observable outcomes)
  const hasObservable = proposal.actionSequence.some(
    (s) => s.params['observableOutcome'] || s.params['driveEffect']
  );
  if (!hasObservable) violations.push('no_observable_outcome_for_contingency');

  return {
    passed: violations.length === 0,
    reasoning: violations.length === 0
      ? 'All constraints passed (deterministic)'
      : `Failed: ${violations.join(', ')}`,
    violations,
    attemptsUsed: 1,
    deferred: false,
  };
}
```

### Answers to Open Questions
- **Theater detection:** Check `predictedDriveEffects` is non-empty. Plans with zero drive effects are theatrical by definition
- **Refinement loop:** Simplify to single-pass. Deterministic validation gives exact violations; the proposal generator can address them directly. Remove the refine-then-revalidate loop
- **Queue behavior change:** Yes — validation is always available, so `deferred: true` is never returned. This eliminates the busy-loop problem from idea #2 for the validation stage. The backoff from idea #2 would still be useful for the proposal stage when LLM is unavailable
- **LLM fallback:** Not needed. If constraints 4-5 need more nuance later, add specific structural checks rather than falling back to LLM

### Risks
- **False positives on theater check:** A plan with indirect drive effects (through graph state changes) might be flagged. Start with a conservative check (any drive effect = pass) and tighten later
- **Procedure conflict detection:** Simple `category + trigger_context` equality may miss semantic conflicts. Acceptable for v1; can add embedding similarity later
- **Refinement loop removal:** Existing proposal generators may rely on the refine-then-revalidate pattern. Verify that `ProposalService.refine()` callers handle single-pass validation

---

## 10. Deterministic Edge Refinement

### Verdict: PROCEED - LLM Cost Reduction

### Current State
- **File:** `learning/src/pipeline/refine-edges.service.ts`, line 143
- Uses `tier: 'quick'` LLM call with `temperature: 0.3` and `maxTokens: 512`
- Classifies `RELATED_TO` edges into 16 specific types (LIKES, KNOWS, WORKS_AT, etc.)
- When LLM is unavailable, refinement is skipped entirely (Lesion Test support, line 99-104)

### Key Findings
- **16 valid edge types:** LIKES, DISLIKES, KNOWS, WORKS_AT, LIVES_AT, OWNS, USES, CREATED, BELONGS_TO, IS_PART_OF, IS_TYPE_OF, LOCATED_IN, HAS_PROPERTY, CAUSED_BY, LED_TO, RELATED_TO
- **LLM input is simple classification:** Entity pairs (e.g., "Jim → Google") plus up to 5 recent `INPUT_PARSED` conversation events as context. The LLM returns one line per edge: `EDGE: <source> -> <target> | <TYPE>`
- **Fallback is inherently safe:** Edges already exist as `RELATED_TO`. Unrefined edges lose nothing. A conservative heuristic that only reclassifies high-confidence patterns is strictly better than the current Lesion Test fallback (skip entirely)
- **No entity semantic types in WKG:** All entities have `node_type = 'Entity'` — no `Organization`, `Person`, `Place` distinctions. The classifier must infer from labels and conversation context alone
- **Person detection heuristic exists:** `isPersonLike()` at lines 380-382 checks `/^[A-Z][a-z]+$/`. Could be extended for organization/place patterns
- **Confidence and provenance:** Refined edges keep `LLM_GENERATED` provenance (from the extraction step) with confidence 0.35. Edges are renamed in Neo4j via CREATE + DELETE pattern with `refined_from: 'RELATED_TO'` metadata

### Recommended Implementation
```typescript
const VERB_RULES: Array<{
  pattern: RegExp;
  edgeType: string;
}> = [
  { pattern: /\b(?:likes?|loves?|enjoys?|fan of)\b/i, edgeType: 'LIKES' },
  { pattern: /\b(?:hates?|dislikes?|can't stand)\b/i, edgeType: 'DISLIKES' },
  { pattern: /\b(?:works?\s+(?:at|for)|employed|job at)\b/i, edgeType: 'WORKS_AT' },
  { pattern: /\b(?:lives?\s+(?:in|at)|resides?|home in)\b/i, edgeType: 'LIVES_AT' },
  { pattern: /\b(?:uses?|using|works? with)\b/i, edgeType: 'USES' },
  { pattern: /\b(?:created?|built|made|wrote|authored)\b/i, edgeType: 'CREATED' },
  { pattern: /\b(?:owns?|has a|bought)\b/i, edgeType: 'OWNS' },
  { pattern: /\b(?:knows?|met|friends? with)\b/i, edgeType: 'KNOWS' },
  { pattern: /\b(?:caused|because of|due to)\b/i, edgeType: 'CAUSED_BY' },
  { pattern: /\b(?:led to|resulted in)\b/i, edgeType: 'LED_TO' },
  { pattern: /\b(?:located in|based in|situated)\b/i, edgeType: 'LOCATED_IN' },
  { pattern: /\b(?:part of|member of|belongs? to)\b/i, edgeType: 'BELONGS_TO' },
];

function classifyEdge(
  sourceLabel: string, targetLabel: string, conversationContext: string,
): string {
  for (const rule of VERB_RULES) {
    if (rule.pattern.test(conversationContext)) {
      return rule.edgeType;
    }
  }
  return 'RELATED_TO'; // No confident classification
}
```

### Answers to Open Questions
- **Use entity nodeType?** Not currently available (all entities are `Entity`). Would be valuable if entity type extraction is added later
- **Context scope:** Use the same 5 recent `INPUT_PARSED` events that the LLM receives. The `gatherPersonContext()` method already assembles this
- **Confidence for heuristic edges:** Use `INFERENCE` provenance (0.30) instead of `LLM_GENERATED` (0.35). This is more honest — the heuristic is less capable than the LLM — and keeps the confidence ceiling lower for unverified refinements
- **Maintain LLM path?** Yes, as an optional enrichment. When LLM is available and idle, use it for edges the heuristic left as `RELATED_TO`. When unavailable, the heuristic runs alone. This is strictly better than the current skip-entirely Lesion Test fallback
- **Embedding similarity:** Defer to v2. Adds complexity and requires pre-computed type exemplars

### Risks
- **False positive classification:** A regex matching "works" in "that works well" could produce a spurious WORKS_AT edge. Mitigate by requiring both source/target labels to be present in the matching context window
- **Lower accuracy than LLM:** Expected and acceptable. The RELATED_TO fallback is safe, and the LLM can refine heuristic-classified edges later when available
- **Provenance distinction:** If heuristic-refined edges use `INFERENCE` provenance, they'll have lower confidence (0.30 vs 0.35) than LLM-refined edges. This is desirable — it signals lower reliability

---

## 11. Learning Pipeline Dead-Letter Tracking

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

## 12. Perception Thread-Safe State and Lazy Init

### Verdict: PROCEED - Reliability

### Current State
- **File:** `perception-service/main.py`, lines 85-100
- `_AppState` is a shared mutable singleton with **zero synchronization primitives**
- Accessed from FastAPI async handlers (event loop) and thread pool executors concurrently
- Downstream components (DebugFrameStore, FrameBuffer, CircuitBreaker) implement their own locking, but _AppState itself is completely unprotected

### Key Findings
- **5 confirmed race conditions:**

| # | Component | Location | Type | Severity |
|---|-----------|----------|------|----------|
| 1 | `frame_sequence` increment | main.py:297 | Read-Modify-Write | HIGH |
| 2 | `embedding_extractor` lazy-init | main.py:614, 667 | TOCTOU | HIGH |
| 3 | `_embedding_init_failed` global | main.py:643 | Unsynchronized bool | MEDIUM |
| 4 | `tracker._tracks` read from /status | main.py:801 vs :366 | Concurrent read/write | HIGH |
| 5 | `IoUTracker.update()` | tracker.py:287 | Concurrent mutation | HIGH |

- **frame_sequence (race #1):** Line 297 `_state.frame_sequence += 1` is a read-modify-write on a plain int. Two concurrent `/detect` requests can get the same sequence number, corrupting tracker temporal ordering
- **Embedding extractor (race #2):** Classic TOCTOU — `if _state.embedding_extractor is None` check followed by construction in two independent code paths (main.py:614 in `/crop-face` and :667 in `_extract_track_embedding`). Both run in thread executors. Two concurrent requests can both pass the None check and both initialize, causing resource leak
- **tracker._tracks (race #4):** `/status` endpoint reads `len(_state.tracker._tracks)` (line 801) on the event loop while `/detect` calls `tracker.update()` (line 366) which replaces `self._tracks` (tracker.py:287). IoUTracker has no internal synchronization
- **Existing lock patterns in the codebase:**
  - `DebugFrameStore`: `asyncio.Lock()` — properly protected
  - `FrameBuffer`: `threading.Lock()` + `threading.Event()` — properly protected
  - `CircuitBreaker`: `asyncio.Lock()` + `asyncio.Semaphore()` — properly protected

### Recommended Implementation
1. **`frame_sequence`:** Use `asyncio.Lock()` (since the increment happens in async handler context) or `itertools.count()` (atomic increment)
2. **`embedding_extractor`:** Use `threading.Lock()` (since initialization happens in thread executor). Replace TOCTOU pattern with double-checked locking:
```python
_embedding_lock = threading.Lock()

def _get_or_init_embedding_extractor():
    if _state.embedding_extractor is not None:
        return _state.embedding_extractor
    with _embedding_lock:
        if _state.embedding_extractor is not None:
            return _state.embedding_extractor
        _state.embedding_extractor = OnnxEmbeddingExtractor()
        return _state.embedding_extractor
```
3. **`tracker._tracks`:** Add a public `get_active_track_count()` method to IoUTracker that returns `len(self._tracks)` (safe since list assignment is atomic in CPython). Alternatively, use `asyncio.Lock()` around tracker access in the async handlers
4. **Consider eager init:** Replace lazy embedding extractor init with eager init at startup behind a feature flag, eliminating the race entirely

### Answers to Open Questions
- **asyncio.Lock vs threading.Lock:** Both are needed. `asyncio.Lock` for event-loop-only state (frame_sequence, tracker access from async handlers). `threading.Lock` for state accessed from thread executors (embedding extractor init)
- **Concurrency semaphore:** Defer to API gateway level. Adding backpressure inside the service adds complexity without clear benefit at current scale
- **Eager init:** Yes — recommended as the cleanest fix for the embedding extractor race. Eliminates TOCTOU entirely

### Risks
- **Lock contention:** Negligible at current traffic (single camera, single client). Even with multiple clients, contention would be sub-millisecond
- **Deadlock potential:** Low — locks protect very small critical sections (counter increment, init check, list length)
- **CPython GIL:** Provides some incidental protection for simple operations, but relying on it is an anti-pattern. Explicit synchronization is correct

---

## 13. Scope-Aware CALLS Edge Resolution

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

## 14. Rule-Based Cross-Modulation Engine

### Verdict: NO ACTION NEEDED — Already Implemented

### Current State
- **File:** `drive-engine/src/drive-process/cross-modulation.ts`
- The cross-modulation system is **already declarative and rule-based** — not hardcoded conditional blocks as the idea assumes
- Uses a clean `CrossModulationRule` TypeScript interface with 5 active rules defined as typed objects in a priority-ordered array
- Rules iterate in priority order; each rule sees values modified by previous rules (cascading evaluation)

### Key Findings
- **5 active cross-modulation rules already defined as typed objects:**

| Rule ID | Source | Target | Threshold | Mode | Coefficient |
|---------|--------|--------|-----------|------|-------------|
| satisfaction-suppresses-boredom | Satisfaction | Boredom | 0.6 | multiplicative | 0.03 |
| anxiety-amplifies-integrity | Anxiety | Integrity | 0.7 | additive | 0.0012 |
| system-health-amplifies-anxiety | SystemHealth | Anxiety | 0.7 | additive_gap | 0.003 |
| boredom-amplifies-curiosity | Boredom | Curiosity | 0.6 | additive_gap | 0.003 |
| guilt-suppresses-satisfaction | Guilt | Satisfaction | 0.4 | multiplicative | 0.03 |

- **All coefficients are immutable constants** in `constants/drives.ts` (lines 97-180), validated at startup
- **Rule format is individually testable** with clean type safety
- **CANON Standard 6 is preserved:** Hardcoded rules cannot be modified by the system at runtime
- **The existing RuleEngine (for guardian rules)** is a separate, PostgreSQL-backed system with 60-second reload cycle and LRU cache — a different concern entirely

### Recommendation
Close this idea as already implemented. If future enhancement is desired (e.g., database-backed cross-modulation rules with guardian approval workflow, per-rule telemetry), those should be tracked as separate, more specific ideas.

---

## 15. Decision Cycle Structured Error Recovery

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
1. **Dead-Letter Tracking + Error Recovery:** The dead-letter table could store error-context episodes from decision-making failures. Both ideas reference this overlap
2. **Concurrent Persistence Checks + Configurable Weights + Observation Validation:** All three touch the perception pipeline. Implementing together avoids triple-touching the same code
3. **Deterministic Constraint Validation + Deterministic Edge Refinement:** Both reduce LLM dependency. The constraint validation change eliminates the busy-loop that planning backoff (#2) addresses
4. **Planning Requeue Backoff + Deterministic Constraint Validation:** Backoff addresses the symptom (busy loop); deterministic validation removes the root cause (LLM dependency). Together they provide defense-in-depth
5. **Anxiety Injection + Error Recovery:** Both fix CANON compliance gaps. Anxiety injection is surgical (one file); error recovery is systemic
6. **Prediction Evaluator Memory + Thread-Safe State:** Both address runtime reliability in long-running processes. Independent but same operational concern

### Recommended Implementation Order

**Wave 1 — Quick Wins (1-2 days each, independent):**
1. Inject Anxiety into Outcome Reporter — CANON compliance fix
2. Concurrent Persistence Checks — immediate performance benefit
3. Prediction Evaluator Memory Lifecycle — prevents memory leak
4. Opportunity Queue Eviction — prevents priority inversion

**Wave 2 — Quality Gates (2-3 days each):**
5. Configurable Persistence Check Weights — pairs with #2
6. Grounded Confidence for Reflection Insights — graph quality signal
7. Observation Validation Pipeline — pre-ingestion quality gate
8. Planning Requeue Backoff — prevents busy-loop waste

**Wave 3 — LLM Reduction (3-5 days each):**
9. Deterministic Constraint Validation — eliminates deep-tier LLM call
10. Deterministic Edge Refinement — replaces quick-tier LLM call with heuristic

**Wave 4 — Infrastructure (1-2 weeks):**
11. Perception Thread-Safe State — reliability under concurrency
12. Learning Pipeline Dead-Letter Tracking — operational visibility
13. Scope-Aware CALLS Edge Resolution — PKG accuracy

**Wave 5 — Cross-Cutting (2+ weeks):**
14. Decision Cycle Structured Error Recovery — largest scope, benefits from earlier waves

**No Action:**
15. Rule-Based Cross-Modulation Engine — already implemented

---

# New Ideas Research (2026-04-12)

---

## 16. Clean Up Stale Stub Comments in ActionHandlerRegistryService

### Verdict: PROCEED - Low-Effort Documentation Cleanup

### Current State
- **File:** `packages/decision-making/src/action-handlers/action-handler-registry.service.ts`
- Class-level JSDoc (lines 2-29) claims handlers are "stubs that log intent" and "will be replaced with wired implementations"
- Actual implementations are fully wired: LLM_GENERATE calls `this.llmService.complete()`, WKG_QUERY calls `this.wkgContext` methods, TTS_SPEAK returns text for delivery, LOG_EVENT is functional, RESEARCH_ENTITY searches SearXNG and writes to WKG

### Key Findings
- All handlers ARE fully implemented with real service calls
- `@Optional` decorators on `llmService` and `wkgContext` are justified for graceful degradation but comments claiming "stubs" are misleading
- New contributors reading lines 14-26 would believe the system is non-functional

### Recommended Implementation
1. Update class-level JSDoc to reflect actual wired state
2. Clarify `@Optional` decorators enable graceful fallback, not incomplete implementation
3. Remove "will be replaced" language

### Risks
- None — documentation-only change

### Answers to Open Questions
- **Are there genuinely incomplete handlers?** No. All are fully implemented
- **Should `@Optional` injections become required?** No. Keep for test/partial-deployment resilience

---

## 17. Wire HALLUCINATED_KNOWLEDGE and DEPRESSIVE_ATTRACTOR Detectors

### Verdict: NO ACTION - Already Implemented

### Current State
- **File:** `packages/decision-making/src/monitoring/attractor-monitor.service.ts`
- HALLUCINATED_KNOWLEDGE detector (lines 342-427): Fully implemented. Queries WORLD Neo4j for provenance distribution with 30s TTL cache
- DEPRESSIVE_ATTRACTOR detector (lines 456-522): Fully implemented. Composite signal from SHRUG rate, MAE, and elevated negative drives via `driveStateReader.getCurrentState()`

### Key Findings
- Both detectors are production-ready and active in `runDetectors()`
- Neo4jService and IDriveStateReader are properly injected and used
- No null-casting issue exists in current code
- Alerts emit through DECISION_EVENT_LOGGER

---

## 18. Forward Drive Events to TimescaleDB Event Backbone

### Verdict: PROCEED - Medium Effort, Medium Value

### Current State
- **File:** `packages/drive-engine/src/drive-process/drive-process-manager.service.ts`
- DRIVE_EVENT handler (lines 193-202) only logs to NestJS logger
- TODO comment states "Forward to event backbone (TimescaleDB)"
- TimescaleService is already injected; OPPORTUNITY_CREATED uses the working pattern

### Key Findings
- Infrastructure for writing to TimescaleDB is present and operational
- DRIVE_EVENT payload contains `driveEventType` and `drive` properties
- No decision on batching vs. individual writes exists

### Recommended Implementation
1. Implement `writeDriveEvent()` mirroring `writeOpportunityEvent()` pattern
2. Schema: event timestamp, driveEventType, drive name, tick number, session ID
3. Individual writes initially (current pattern), batch if performance requires

### Risks
- Backpressure if drive events fire >100/sec — consider batching
- Timestamp accuracy depends on payload including computed tick time

---

## 19. Implement DrivesController Stub Endpoints

### Verdict: PROCEED - Quick Win, Medium Value

### Current State
- **File:** `apps/sylphie/src/controllers/drives.controller.ts`
- Three POST endpoints defined (`/drives/override`, `/drives/drift`, `/drives/reset`) that accept requests but return empty `{}`
- `driveReader` injected but only used for GET endpoint

### Key Findings
- No IPC message types for OVERRIDE_SET, DRIFT_SET, OVERRIDE_RESET exist yet
- WsChannelService.send() is available for outbound IPC
- No write path exists from main process to drive child

### Recommended Implementation
1. Create IPC message types in shared drive-engine types
2. Wire DriveProcessManagerService into controller
3. Each endpoint: validate input → construct IPC message → send → return result
4. Add logging for audit trail

### Risks
- Safety constraints unclear — should overrides be dev-mode only?
- Range validation needed (drives typically [0, 1])
- No feedback mechanism for whether override was applied

---

## 20. Wire IPCSelfKgReader for Real KG(Self) Access in Drive Process

### Verdict: NEEDS MORE INFO - High Effort, High Value

### Current State
- **File:** `packages/drive-engine/src/drive-process/database-clients.ts`
- FallbackSelfKgReader (lines 36-104) returns empty arrays for all queries
- IPCSelfKgReader (lines 114-141) is entirely unimplemented — constructor sets `ready: false`
- Phase 2 TODO confirms switch to IPCSelfKgReader needed

### Key Findings
- WsChannelService supports fire-and-forget only — no request/response pattern
- IPC request/response requires: message ID tracking, promise map, handler that resolves by ID
- Self-evaluation loop runs without actual baseline data — no adjustment occurs

### Recommended Implementation
1. Implement `IPCSelfKgReader._queryViaIPC()` with Promise-based request/response
2. Wire WsChannelService for bidirectional communication
3. Main process handlers to query Grafeo and respond
4. 5-minute TTL cache to reduce IPC volume

### Risks
- IPC protocol design incomplete (request/response not yet established)
- Circular module dependency risk
- 10-tick interval with RPC latency could impact drive tick timing

---

## 21. Support 'call' Step Type in MorphologyExecutor

### Verdict: PROCEED - Medium Effort, Medium Value

### Current State
- **File:** `packages/perception-service/cobeing/layer3_knowledge/morphology_executor.py`
- `_execute_string_ast()` raises NotImplementedError for step_type='call'
- ProcedureExecutor fully implements 'call' with recursion depth limiting and cycle detection

### Key Findings
- MorphologyExecutor already handles 'operation' and 'conditional' step types
- ProcedureExecutor works with ValueNode IDs; MorphologyExecutor with Python strings
- Cycle detection and recursion limiting are essential patterns to replicate

### Recommended Implementation
1. Add 'call' branch to `_execute_string_ast()` with target procedure resolution
2. Add cycle detection via active procedure stack
3. Add recursion depth limit (recommend 10)
4. Implement own version rather than delegating to ProcedureExecutor (different semantics)

### Risks
- Infinite recursion without cycle detection
- "Executor unification" mentioned as future epic — may duplicate code

---

## 22. Remove SensoryLoggerService After Executor Engine Wiring

### Verdict: PROCEED - Medium Effort, Requires Pre-work

### Current State
- **File:** `apps/sylphie/src/services/sensory-logger.service.ts` (54 lines)
- Runs `setInterval` at 2000ms to sample sensory pipeline via `tickSampler.sample()`
- Explicitly documented as "temporary stand-in for executor engine's tick loop"

### Key Findings
- Executor engine IS wired and running cycles through 8 states
- However, executor engine does NOT call `tickSampler.sample()` — no sampling integration
- SensoryLoggerService is the ONLY active sampler of the sensory pipeline
- Removing it without wiring executor engine sampling will break telemetry

### Recommended Implementation
1. Add `tickSampler.sample()` to `ExecutorEngineService.onCycleComplete()`
2. Emit telemetry broadcast from executor engine
3. Remove SensoryLoggerService from providers and delete file
4. Verify telemetry panel still receives frame data

### Risks
- **HIGH**: Removing service without wiring executor sampling loses all sensory telemetry

---

## 23. Simulation Cross-Drive Effect Aggregation

### Verdict: PROCEED - High Value, Medium Effort

### Current State
- **File:** `packages/planning/src/pipeline/simulation.service.ts`
- `evaluateCategory()` aggregates only the `affectedDrive` from historical events; full `driveEffects` map exists in payloads but is discarded (line 188)
- `SimulatedOutcome.estimatedDriveEffect` already supports `Partial<Record<DriveName, number>>`

### Key Findings
- Loop extracts only `effect = driveEffects[affectedDrive]`, ignoring secondary effects
- No cross-drive ranking exists — sorting by single-drive relief only
- Guardian teaching fallback already sets two drives (affectedDrive + CognitiveAwareness)

### Recommended Implementation
1. Aggregate all drives from `driveEffects` in `evaluateCategory()`
2. Update ranking to consider secondary effects
3. Viability threshold applies to primary drive only; ranking considers both

### Risks
- Ranking redesign needed to fairly weight primary vs secondary effects
- Could surface outcomes that relieve collateral drives but worsen target

---

## 24. Implement Real Theater Prohibition Validation

### Verdict: PROCEED - High Value, Medium Effort

### Current State
- **File:** `apps/sylphie/src/services/communication.service.ts` line 778
- Only checks `anxiety > 0.7 && response.text.length > 0`, logs debug, returns `true` (no blocking)
- TODO requests "real theater validation — compare response sentiment against drive state"

### Key Findings
- No sentiment analysis performed; heuristic is incomplete
- Method is called but return value only used for logging/metadata, not filtering
- CycleResponse contains text, driveSnapshot, and arbitrationType — all needed for validation

### Recommended Implementation
1. Define drive-to-sentiment mappings (anxiety→cautious, curiosity→inquisitive, etc.)
2. Start with lightweight sentiment analysis (VADER or similar)
3. Compare detected sentiment against drive state vector
4. Flag-only initially (no blocking); escalate in Phase 2

### Risks
- Sentiment accuracy on short responses can be unreliable
- Drive-to-sentiment mappings are subjective
- False positives could suppress genuine communication

---

## 25. Add Timeout Guards to LLM Calls in Learning Pipeline

### Verdict: PROCEED - Quick Win, High Reliability Impact

### Current State
- **Files:** `packages/learning/src/pipeline/refine-edges.service.ts`, `conversation-reflection.service.ts`, `cross-session-synthesis.service.ts`
- All use `await this.llm.complete()` with no timeout wrapper
- `LlmRequest` interface has no `timeout` or `AbortSignal` field
- `inFlight` guards prevent concurrent cycles but a hung LLM call permanently blocks that cycle type

### Key Findings
- Consistent pattern: bare `await this.llm.complete()` across all three services
- A single hung LLM call permanently blocks its cycle type (maintenance/reflection/synthesis)
- No error handling for timeout in any service

### Recommended Implementation
1. Wrap each LLM call in `Promise.race()` with configurable timeout
2. Per-service timeouts: refine-edges 15-20s, reflection 30-45s, synthesis 30-45s
3. Emit `LEARNING_TIMEOUT` event for observability
4. No immediate retry — wait for next interval

### Risks
- Low: non-breaking addition caught by try-catch
- Too-aggressive timeouts may fail legitimate slow requests

---

## 26. Per-Row Error Isolation in Planning Opportunity Ingestion

### Verdict: PROCEED - Quick Win, High Reliability

### Current State
- **File:** `packages/planning/src/planning.service.ts` line ~232
- `JSON.parse()` NOT wrapped in per-row try-catch in `ingestOpportunities()`
- By contrast, `pollAndEvaluateOutcomes()` correctly wraps each parse in try-catch

### Key Findings
- Inconsistency confirmed: ingestOpportunities lacks per-row isolation while pollAndEvaluateOutcomes has it
- Single bad row aborts entire opportunity intake loop
- Affected rows retry infinitely until aged out

### Recommended Implementation
1. Wrap parse + processing in per-row try-catch with `continue` on error
2. Extract shared `safeParsePayload()` utility
3. Mark failed rows as processed to prevent infinite retry
4. Emit `OPPORTUNITY_INTAKE_ERROR` event

### Risks
- Low: improves resilience with no change for valid rows

---

## 27. Add Jitter and Iterative Retry in Recovery Mechanism

### Verdict: PROCEED - Low Effort, Medium Value

### Current State
- **File:** `packages/drive-engine/src/ipc-channel/recovery.ts`
- Uses recursive `return this.attemptRecovery()` on failure (bounded by maxRetries=3)
- Deterministic exponential backoff: 1s → 2s → 4s → 8s, capped at 60s
- No jitter — all instances reconnect simultaneously (thundering herd risk)
- `pendingMessageCount` hardcoded to 0

### Key Findings
- Recursive retry confirmed at line 158; bounded but fragile
- No jitter creates thundering herd on reconnect
- `incrementReconnectCount()` exists and works properly
- Structure is sound — just needs jitter and iteration

### Recommended Implementation
1. Replace recursion with while loop
2. Add ±25% jitter to backoff delays
3. Fix `pendingMessageCount` to read actual queue size
4. Make jitter configurable in `RecoveryOptions`

### Risks
- Low-medium: iterative loop is safer than recursion
- Test edge case: maxRetries=0

---

## 28. Adaptive Candidate Scoring Weights

### Verdict: PROCEED - High Value, Medium Effort

### Current State
- **File:** `packages/decision-making/src/deliberation/deliberation.service.ts` (lines 799-880)
- Hardcoded scoring weights: GROUNDED +1.0, LLM_ASSISTED +0.5, chatbot -0.5, etc.
- ConfidenceUpdaterService emits outcome signals but doesn't feed back into deliberation weights

### Key Findings
- Weight discovery mechanism exists but is disconnected from scoring
- No per-intent weight tuning currently exists
- Guardian feedback system (confirmation=2x, correction=3x multipliers) proves selective reinforcement infrastructure exists
- Supervisor verdict data doesn't persist or influence future scoring

### Recommended Implementation
1. Create CandidateScoringWeightsService with per-intent adaptive weights
2. Implement EMA weight update rule (α=0.05) correlated with outcome confidence
3. Persist weights to TimescaleDB for cross-restart continuity
4. Guard against collapse: clamp weights to [0.0, 2.0], diversity checks

### Risks
- Weight collapse without diversity guards
- Slow convergence with conservative EMA
- Observational bias from early sessions

---

## 29. Perception Frame Source Timeout Guards

### Verdict: PROCEED - Quick Win, Medium Risk

### Current State
- **File:** `packages/perception-service/cobeing/layer2_perception/frame_sources.py`
- `CameraFrameSource.get_frame()` uses `run_in_executor()` for blocking `cv2.VideoCapture.read()` with no timeout
- Deprecated `asyncio.get_event_loop()` used (should be `get_running_loop()`)

### Key Findings
- No timeout on blocking I/O — hung USB/RTSP stream blocks forever
- CaptureError exception exists and should be raised on timeout
- Sequence counter handles dropped frames robustly

### Recommended Implementation
1. Add `capture_timeout_seconds` to CameraConfig (default 5.0s)
2. Wrap executor call in `asyncio.wait_for()`
3. Migrate to `asyncio.get_running_loop()`
4. Optional: exponential backoff retry (1s delay, max 3 timeouts)

### Risks
- 5s timeout may be too aggressive for RTSP streams (use 10s for network cameras)
- Timeout detects hang but doesn't recover device

---

## 30. Supervisor Verdict Audit Trail

### Verdict: PROCEED - High Value, Medium Effort

### Current State
- **File:** `packages/supervisor/src/supervisor.service.ts`
- `recentVerdicts` buffer capped at 100 entries, in-memory only
- `pendingInterventions` array grows unbounded (never consumed — memory leak)
- No persistence to TimescaleDB

### Key Findings
- Verdicts lost on restart — no historical analysis possible
- pendingInterventions queue is a memory leak
- Cost tracking is ephemeral with no audit trail
- Reasoning traces from DeepSeek are currently discarded

### Recommended Implementation
1. Create `supervisor_verdicts` hypertable in TimescaleDB
2. Emit `SUPERVISOR_VERDICT` events after verdict parsing
3. Persist interventions immediately with status tracking
4. Capture reasoning traces (truncate to 2KB for storage)
5. Clear pendingInterventions after dispatch

### Risks
- Large reasoning traces could bloat storage — truncate or compress
- Event emission overhead — use fire-and-forget pattern

---

## 31. Ungrounded Insight Re-grounding Sweep

### Verdict: NEEDS MORE INFO - High Value, Clarification Needed

### Current State
- **File:** `packages/learning/src/pipeline/conversation-reflection.service.ts` (lines 430-567)
- `persistInsight()` creates Insight nodes with `grounded` boolean and penalized confidence
- Once persisted with `grounded=false`, insights remain ungrounded forever — no re-evaluation

### Key Findings
- Insight grounding computed once at creation; no upgrade path
- No re-grounding infrastructure or timer-driven cycle exists
- LearningService has timer patterns that could host a re-grounding cycle

### Recommended Implementation
1. Create InsightRegroundingService with `regroundInsights()` method
2. Query for ungrounded insights, re-attempt REVEALS edge creation
3. Add 30-minute timer to LearningService
4. Add TTL: mark insights as `confabulated` after 5 failed sweeps

### Risks
- Confidence recomputation semantics need clarification
- Could emit events in bulk — use batched event emission

---

## 32. Windowed Sampling for Long Session Reflection

### Verdict: PROCEED - High Value, Medium Complexity

### Current State
- **File:** `packages/learning/src/pipeline/conversation-reflection.service.ts` (lines 695-737)
- `buildReflectionPrompt()` stops at `MAX_CONVERSATION_CHARS = 8000` — only first ~3-5 minutes of a 30-minute conversation sent to LLM
- System prompt calls for TONAL_SHIFT and DELAYED_REALIZATION insights but truncation makes them impossible to detect

### Key Findings
- Hard truncation discards conversation tail
- TONAL_SHIFT and DELAYED_REALIZATION require comparing early and late parts
- MAX_CONVERSATION_CHARS is non-adaptive (fixed 8000)

### Recommended Implementation
Head + Tail + Sampled Middle strategy:
1. Reserve HEAD_CHARS=2000, TAIL_CHARS=2000, MIDDLE_CHARS=4000
2. Sample middle uniformly (one event per bucket)
3. Scale budget by session length (8k→12k→16k)
4. Optional two-pass: fast summarization → detailed insight extraction

### Risks
- Sampling introduces blind spots in middle section
- Two-pass approach doubles LLM cost
- Head/tail overlap for very short conversations

---

## 33. Learning Pipeline Neo4j Session Batching

### Verdict: PROCEED - Quick Win, Low Risk

### Current State
- **File:** `packages/learning/src/pipeline/upsert-entities.service.ts` (lines 86-163)
- Each entity label opens a fresh Neo4j WRITE session, runs MERGE, closes session
- Up to 20 sessions per event, 100 per maintenance cycle
- ExtractEdgesService already uses the efficient UNWIND+MERGE batched pattern

### Key Findings
- Per-entity session pattern exists across two services (upsert-entities, can-produce-edges)
- Extract-edges demonstrates the target state (single session, UNWIND+MERGE)
- Session overhead adds ~5-10ms per open/close

### Recommended Implementation
1. Replace per-entity loop with batched UNWIND+MERGE (one session, one Cypher statement)
2. Remove private `mergeEntityNode()` method
3. Apply same pattern to can-produce-edges.service.ts
4. Check result.records.length for error isolation

### Risks
- Batch failure loses all items (mitigate with idempotent MERGE)
- Performance improvement modest (~100-200ms per cycle) but code is cleaner

---

## 34. Supervisor Adaptive Sampling Based on Verdict Trends

### Verdict: PROCEED - High Value, Medium Effort

### Current State
- **File:** `packages/supervisor/src/supervisor.service.ts`
- Static modulo sampling: `cycleCount % sampleRate === 0`
- `recentVerdicts` buffer provides signal for adaptive rate
- Binary `burstMode` is the only current adaptive mechanism
- Cost tracking via `CostTrackerService` with `budgetRemaining()` and `hasBudget()`

### Key Findings
- Infrastructure 95% ready: recentVerdicts buffer maintained, VerdictRating types exist
- No observable/metric showing adaptive rate in real-time
- `alwaysEvaluate` events noted as TODO but not wired

### Recommended Implementation
1. Add `AdaptiveSamplingConfig` to SamplingPolicy (minRate, maxRate, windowSize, thresholds)
2. Extend `shouldEvaluate()` to compute trend from recent verdicts
3. Update rate dynamically based on verdict distribution
4. Factor budget remaining into tightening decisions

### Risks
- Too aggressive tightening could exhaust budget during problem periods
- Window size requires empirical tuning
- burstMode and adaptive mode interaction needs definition

---

## 35. Decision Cycle Concurrency Guard

### Verdict: PROCEED - Critical Fix, High Effort

### Current State
- **File:** `packages/decision-making/src/decision-making.service.ts`
- Pre-cycle guard checks `executorEngine.getState() !== IDLE` (lines 413-419) — synchronous only
- `tickInFlight` boolean flag exists but is not a proper mutex
- No bounded queue for incoming frames

### Key Findings
- Race window between IDLE check and state transition is real vulnerability
- Concurrent `processInput()` calls could interleave state transitions, double-flush event buffers, corrupt cycle IDs
- No backpressure signal to upstream

### Recommended Implementation
1. Replace `tickInFlight` with proper semaphore (async-lock or RxJS concatMap)
2. Queue incoming frames FIFO with max depth 5-10
3. Add queue depth metric and warnings at depth >2
4. Emit `QUEUE_BACKLOG_WARNING` IPC message if sustained

### Risks
- Queue increases latency for rapid frame arrival
- Queued frames may age and become stale
- Complex error handling for mid-cycle failures

---

## 36. Drive Tick-Loop Observability Instrumentation

### Verdict: PROCEED - Quick Win, Medium Value

### Current State
- **File:** `packages/drive-engine/src/drive-process/drive-engine.ts`
- 100Hz tick loop with drift compensation; `tickStartMs = Date.now()` captured
- Only logs checkpoint every 100 ticks — no per-tick latency or histogram
- Outcome queue depth warned but not metered
- No budget-exceeded alert or `/drives/health` endpoint

### Key Findings
- Infrastructure mostly there: tickStartMs captured, lastTickCompletedAt tracked
- Duration computable at tick end but not collected
- No systematic sampling or histogram

### Recommended Implementation
1. Sample every 100th tick: collect min/p50/p99/max latency
2. Track outcome queue depth at drain time
3. Log warning on tick >10ms (once per contiguous overrun)
4. Emit `TICK_PERFORMANCE_SAMPLE` IPC message periodically
5. Create optional `/drives/health` endpoint

### Risks
- Instrumentation overhead could itself cause budget exceedance — use sampling

---

## 37. Richer Semantic Extraction in Episodic Memory Consolidation

### Verdict: NEEDS MORE INFO - High Value, Unresolved Dependencies

### Current State
- **File:** `packages/decision-making/src/episodic-memory/consolidation.service.ts`
- Entity extraction (lines 312-335): title-cased token split — misses multi-word entities and lowercase domain terms
- Relationship extraction (lines 346-371): always produces exactly 2 triples, second object is always literal `"observed_outcome"` regardless of actual outcome

### Key Findings
- Extractions are heavily heuristic-based and underspecified
- `contextFingerprint` is available but underutilized
- Outcome data (`driveEffectsObserved`) not persisted to Episode — prevents rich triple generation
- LLM call could add ~500ms per episode (acceptable for 2-hour-old episodes)

### Recommended Implementation
1. Multi-word entity extraction via regex patterns and domain vocabulary
2. Variable-count triples (1-5) based on context with actual outcome data
3. Hybrid approach: regex for entities, lightweight LLM for relationships
4. **Prerequisite:** verify outcome data flows to Episode records

### Risks
- More triples = more noise in WKG without confidence calibration
- LLM coupling: Ollama unavailability blocks consolidation
- Outcome data may not be available at consolidation time

---

## 38. Configurable LLM Pricing Rates in Cost Tracker

### Verdict: PROCEED - Quick Win, Minimal Risk

### Current State
- **File:** `packages/supervisor/src/cost-tracker.service.ts`
- Hardcoded DeepSeek pricing: $0.28/M input, $0.42/M output (lines 44-46)
- ConfigService already injected

### Key Findings
- Trivial change: replace two magic numbers with ConfigService lookups
- No historical dependence on exact rate values

### Recommended Implementation
1. Add `DEEPSEEK_INPUT_PRICE_PER_M` and `DEEPSEEK_OUTPUT_PRICE_PER_M` env vars
2. Replace hardcoded values with `parseFloat(this.config.get(...))`
3. Log active rates at startup
4. Optional: `PRICING_LAST_VERIFIED` date with staleness warning

### Risks
- Minimal: config-driven, no logic changes
- Validate against negative/zero values

---

## 39. Simulation Parallel Category Evaluation

### Verdict: PROCEED - Quick Win, Medium Value

### Current State
- **File:** `packages/planning/src/pipeline/simulation.service.ts`
- `simulate()` iterates 5 CANDIDATE_CATEGORIES with sequential `await`
- Each `evaluateCategory()` runs independent TimescaleDB query — no data dependencies
- `Promise.allSettled` pattern already used elsewhere in codebase

### Key Findings
- Queries are truly independent (different actionType filters)
- Sequential: ~5x single query time; parallel: ~1x (bound by slowest)
- Results sorted after completion — no ordering requirement

### Recommended Implementation
1. Replace `for...of` with `Promise.allSettled` mapping over categories
2. Inspect status of each result for partial success handling
3. Optional: concurrency limit if TimescaleDB pool is small

### Risks
- Connection pool contention if pool size <5 (likely fine with default 10-20)
- One slow query delays all results (but still faster than sequential)

---

## 40. Deduplicate Perception Embedding Init

### Verdict: BLOCKED - File Not Found

### Current State
- References `packages/perception-service/main.py` with duplicated `OnnxEmbeddingExtractor` lazy-init
- File and class not found in current codebase mount

### Key Findings
- Perception service may be in a separate repository or unmounted location
- Cannot verify claims or assess feasibility

### Recommended Action
- Verify perception-service codebase location before proceeding

---

## 41. Fix Guilt Repair Behavioral Change Detection (Dead Code Path)

### Verdict: PROCEED - Critical Bug Fix, High Value

### Current State
- **File:** `packages/drive-engine/src/drive-process/behavioral-contingencies/contingency-coordinator.ts` (lines 100-108)
- Bug confirmed: passes `outcome.actionType` for BOTH current action and previous error action type
- `detectBehavioralChange()` always returns false (compares value to itself)

### Key Findings
- 0.15 relief (behavioral change only) is unreachable
- 0.30 relief (both acknowledgment + behavioral change) is unreachable
- Only 0.10 acknowledgment relief can fire — severely limiting guilt repair
- `GuiltyRepair.getRecentErrors()` exists but coordinator never uses it

### Recommended Implementation
1. Add `getLastErrorActionType()` helper to GuiltyRepair
2. Update coordinator to pass actual previous error action type:
   ```typescript
   previousErrorActionType: this.guiltyRepair.getLastErrorActionType(),
   ```
3. Add tests covering all three relief paths

### Risks
- "Any different action = behavioral change" may be too broad — consider semantic similarity
- 15-minute error history timeout may need tuning

---

## 42. Live ageWeight Decay for Episodic Memory

### Verdict: PROCEED - Correctness Critical, Medium Effort

### Current State
- **File:** `packages/decision-making/src/episodic-memory/episodic-memory.service.ts` (line 200)
- `ageWeight = input.attention` set at encode time, NEVER recalculated
- Docstring says formula should be `attention * exp(-0.1 * hoursSinceEncoding)` but exponential term never applied

### Key Findings
- Consolidation candidates sorted by frozen ageWeight — not decayed
- 3-hour-old episode with attention 0.70 should have weight ~0.23 but retains 0.70
- MIN_CONFIDENCE_THRESHOLD (0.65) is miscalibrated — high-attention episodes always pass regardless of age
- queryByContext also uses frozen weight for relevance sorting

### Recommended Implementation
1. Store `initialAttention` separately, compute ageWeight on read
2. Create `computeAgeWeight(initialAttention, timestamp, decayConstant=0.1)` helper
3. Update ConsolidationService and queryByContext to use live-computed weight
4. Backward compat: initialize `initialAttention = ageWeight` for old checkpoints
5. Recalibrate MIN_CONFIDENCE_THRESHOLD (suggest 0.60 initially)

### Risks
- Old never-consolidated episodes may suddenly qualify (brief spike in consolidation)
- Checkpoint compatibility requires migration handling
- Decay constant 0.1 may not be optimal — make configurable

---

## 43. Bootstrap Category Normalization Consistency

### Verdict: PROCEED - Quick Win, Important for Correctness

### Current State
- **bootstrap.py** `record_comparison()`: normalizes with `.lower()` only
- **trainer.py** `ActionVocabulary`: normalizes with `.strip().lower()`
- Asymmetry causes false disagreements when categories have leading/trailing whitespace

### Key Findings
- Whitespace-sensitive categories are realistic from LLM outputs
- False disagreements affect graduation velocity (shadow → audit → partial → full)
- Even one false disagreement per session accumulates tracking errors

### Recommended Implementation
1. Create shared `normalizeCategoryName(category)` → `category.strip().lower()`
2. Use consistently in all comparison sites
3. Audit all normalization sites for consistency

### Risks
- Historical bootstrap logs with old normalization cannot be retroactively corrected
- Check if any code intentionally preserves case

---

## 44. Circuit Breaker and Health-Aware Retry for SidecarControlService

### Verdict: PROCEED - High Value, Medium-High Effort

### Current State
- **File:** `packages/supervisor/src/sidecar-control.service.ts`
- No circuit breaker, retry logic, or health tracking for HTTP calls to cognition sidecar
- Failed interventions silently lost (no retry mechanism)
- Fixed 10-second timeout with no backoff or jitter

### Key Findings
- Lost interventions during sidecar restarts means model doesn't learn from identified mistakes
- No health awareness: all calls fire even when sidecar is known to be down
- No backoff: simultaneous failures during outage create unnecessary load

### Recommended Implementation
1. Implement circuit breaker (CLOSED → OPEN → HALF_OPEN) with 3-failure threshold
2. Queue critical interventions (correct, reinforce) with 5-minute TTL
3. Retry loop processes queue when circuit closes
4. Expose health state via `getModelState()` for dashboard
5. Corrections get higher retry priority than reinforcements

### Risks
- Queued interventions have TTL — extend to 15-30 min if sidecar restarts take longer
- Queue memory pressure for long outages
- Half-open probes during partial recovery could add load

---

## 45. Pre-computed Assistant Pairing in getSplitHistory()

### Verdict: PROCEED - Quick Win

### Current State
- **File:** `apps/sylphie/src/services/conversation-history.service.ts`, lines 181-222
- `getSplitHistory()` walks the history array (outer `while` loop, lines 188-215) and for every answered user message performs a nested forward scan (lines 200-206) to find the corresponding assistant response
- Inner loop scans forward from each user message until it finds an `assistant` role or another `user` role
- Called on **every decision cycle** from `conversation.gateway.ts` line 189, feeding results into `TickSampler`
- History capped at `MAX_MESSAGES = 50` (line 44), so worst-case is bounded at ~2,500 iterations per call, but this compounds across cycles within a session

### Key Findings
- **O(n²) pattern confirmed:** Outer loop iterates all entries; inner loop scans forward per answered user message. With 50 entries and many answered messages, the nested scan adds measurable overhead across frequent calls
- **No caching exists:** The service has no index, map, or cache for user-to-assistant pairing. Each `getSplitHistory()` call re-scans from scratch
- **Four mutation points** would need to maintain/invalidate any index:
  - `addUserMessage()` (line 137) — appends user entry
  - `addAssistantMessage()` (line 148) — appends assistant entry + marks preceding user messages as `answered: true`
  - `trim()` (line 258) — uses `this.history.shift()` to evict from front (shifts all indices)
  - `clear()` (line 248) — empties the array
- **No other lookahead patterns** found in this service. The backward scan in `addAssistantMessage()` (lines 151-159) is a single-pass O(n) operation
- **`trim()` uses `shift()`** which invalidates positional indices — a lazy-cache approach (build on first call, invalidate on mutation) is simpler than maintaining an eager `Map<number, number>`

### Recommended Implementation

**Lazy-cache approach** (simplest, lowest risk):

```typescript
private _splitCache: { pending: string[]; summary: string[] } | null = null;

private invalidateSplitCache(): void {
  this._splitCache = null;
}

getSplitHistory(): { pending: string[]; summary: string[] } {
  if (this._splitCache) return this._splitCache;
  // ... existing logic ...
  this._splitCache = { pending, summary };
  return this._splitCache;
}
```

Add `this.invalidateSplitCache()` calls to `addUserMessage()`, `addAssistantMessage()`, `trim()`, and `clear()`.

Alternatively, a **single-pass index approach** within `getSplitHistory()` itself: build a `Map<number, number>` (user index → next assistant index) in one forward pass, then use direct lookups when constructing pairs. This avoids any external state management while still achieving O(n) per call.

### Answers to Open Questions
- **Incremental map vs lazy cache:** Lazy cache is preferable. The `trim()` method uses `shift()` which would invalidate positional indices, making an incremental `Map<number, number>` fragile. A simple dirty flag is cleaner
- **Other methods with similar patterns:** None found — this is the only nested scan in the service
- **Measurable at 50-message cap?** Individually marginal, but `getSplitHistory()` runs every decision cycle. The optimization is primarily a code-clarity improvement that establishes a pattern for hot-path methods

### Risks
- **Stale cache bug:** If a mutation path misses the `invalidateSplitCache()` call, stale data could be served. Mitigate by adding cache invalidation in a single private `_mutateHistory()` wrapper
- **Negligible:** With 50-message cap, the actual performance gain is small per call. Value is primarily in code hygiene and establishing a pattern

---

## 46. Mood-Congruent Episodic Retrieval

### Verdict: PROCEED - Intelligence Quality Enhancement

### Current State
- **File:** `packages/decision-making/src/episodic-memory/episodic-memory.service.ts`, lines 289-320
- `queryByContext()` tokenizes context fingerprints, computes Jaccard similarity on token sets, filters at threshold 0.70 (`CONTEXT_SIMILARITY_THRESHOLD`, line 64), sorts by ageWeight descending
- **DriveSnapshot is stored with every episode** (line 205, `driveSnapshot` property on Episode type) but is **never consulted during retrieval** — purely semantic matching today
- `IEpisodicMemoryService` interface at `packages/decision-making/src/interfaces/decision-making.interfaces.ts` line 205 defines: `queryByContext(contextFingerprint: string, limit?: number): readonly Episode[]`

### Key Findings
- **`pressureVector` exists and is populated:** `DriveSnapshot.pressureVector` (type `PressureVector`, `packages/shared/src/types/drive.types.ts` lines 113-126) contains 12 named drives (systemHealth, moralValence, integrity, cognitiveAwareness, guilt, curiosity, boredom, anxiety, satisfaction, sadness, focus, social) with values in range **[-10.0, 1.0]**
- **Cosine similarity utility already exists:** `cosineSimilarity(a: number[], b: number[]): number` at `packages/decision-making/src/latent-space/vector-math.ts` lines 5-20. Returns [-1, 1], handles negative values correctly. Ready to import
- **Drive modulation pattern exists in working memory:** `computeDriveModulation()` at `packages/decision-making/src/working-memory/activation.ts` lines 239-254 shows the established pattern for accessing drive pressures by string name from PressureVector
- **WorkingMemoryService already extracts episode drive snapshots:** Line 287 of `working-memory.service.ts` reads `episode.driveSnapshot.pressureVector` for associated-drives inference — confirms the data path is live
- **Interface change is breaking but contained:** `queryByContext` is defined in `IEpisodicMemoryService` interface. Adding an optional `currentDriveSnapshot?: DriveSnapshot` parameter preserves backward compatibility while enabling the new behavior
- **Documentation/implementation discrepancy:** Interface JSDoc (line 196) claims "cosine similarity > 0.7" but implementation uses Jaccard on token sets. This is a pre-existing doc bug, not related to this idea

### Recommended Implementation

1. **Extract pressure vector to number array** — helper function:
```typescript
function pressureVectorToArray(pv: PressureVector): number[] {
  return [
    pv.systemHealth, pv.moralValence, pv.integrity,
    pv.cognitiveAwareness, pv.guilt, pv.curiosity,
    pv.boredom, pv.anxiety, pv.satisfaction,
    pv.sadness, pv.focus, pv.social,
  ];
}
```

2. **Update `queryByContext` signature** (backward-compatible):
```typescript
queryByContext(
  contextFingerprint: string,
  limit?: number,
  currentDriveSnapshot?: DriveSnapshot,
): readonly Episode[];
```

3. **Blend scores in retrieval** (inside existing filter/sort logic):
```typescript
const DRIVE_BLEND_ALPHA = 0.25;
const jaccardScore = jaccardSimilarity(queryTokens, episodeTokens);
let compositeScore = jaccardScore;
if (currentDriveSnapshot) {
  const currentVec = pressureVectorToArray(currentDriveSnapshot.pressureVector);
  const episodeVec = pressureVectorToArray(episode.driveSnapshot.pressureVector);
  const driveSim = (cosineSimilarity(currentVec, episodeVec) + 1) / 2; // normalize to [0, 1]
  compositeScore = (1 - DRIVE_BLEND_ALPHA) * jaccardScore + DRIVE_BLEND_ALPHA * driveSim;
}
// filter: compositeScore >= CONTEXT_SIMILARITY_THRESHOLD
// sort: by compositeScore descending (not ageWeight)
```

4. **Thread drive snapshot from callers** — identify all `queryByContext` call sites and pass the current drive snapshot where available

### Answers to Open Questions
- **What alpha value?** Start at 0.25 as proposed. The semantic signal should dominate; drive similarity acts as a tiebreaker and retrieval-cue. Tune empirically via supervisor audit trail (#30) once implemented
- **Should low-pressure drives contribute?** Yes — cosine similarity naturally handles this. Low-magnitude drives contribute proportionally less to the dot product. No explicit thresholding needed on individual drives
- **Interaction with ageWeight decay (#42)?** Complementary. If #42 (live ageWeight decay) is implemented, the sort order could become a three-factor blend: composite similarity + decayed ageWeight. Recommend implementing #42 first, then layering drive similarity on top
- **Threshold recalibration?** The cosine similarity component is normalized to [0, 1] before blending (via `(cos + 1) / 2`), so the composite score remains in [0, 1] and the existing 0.70 threshold applies without change. Monitor false-negative rate after deployment

### Risks
- **Over-retrieval of emotionally similar but semantically irrelevant episodes:** With alpha=0.25, an episode with perfect drive match (1.0) but low semantic match (0.60) would score `0.75 * 0.60 + 0.25 * 1.0 = 0.70` — exactly at threshold. This is acceptable but worth monitoring
- **PressureVector range asymmetry:** Values span [-10.0, 1.0], heavily skewed negative. Cosine similarity handles direction well but two vectors deep in negative territory (e.g., both at -8.0 across all drives) will show high similarity even though they represent baseline unhappiness rather than a meaningful shared state. Consider normalizing to zero-mean before cosine computation if this proves problematic
- **Interface change propagation:** All callers of `queryByContext` must be updated. Since the new parameter is optional, existing callers continue to work but don't benefit from the feature until updated

---

## Updated Cross-Cutting Observations

### New Idea Clusters

1. **Reliability Quick Wins (1-2 days each):** #25 LLM Timeout Guards + #26 Per-Row Error Isolation + #27 Jitter/Iterative Retry + #29 Perception Timeout Guards + #33 Neo4j Session Batching + #38 Configurable Pricing + #39 Parallel Simulation + #43 Bootstrap Normalization + #45 getSplitHistory() Cache
2. **Critical Bug Fixes:** #41 Guilt Repair Dead Path + #42 ageWeight Decay — both are correctness issues that silently degrade system behavior
3. **Observability:** #30 Supervisor Audit Trail + #34 Adaptive Sampling + #36 Tick Loop Observability + #38 Configurable Pricing
4. **Architecture:** #20 IPCSelfKgReader + #35 Concurrency Guard + #44 Sidecar Circuit Breaker
5. **Intelligence Quality:** #23 Cross-Drive Aggregation + #28 Adaptive Scoring + #32 Windowed Sampling + #37 Semantic Extraction + #46 Mood-Congruent Retrieval
6. **Already Done / No Action:** #17 Attractor Detectors + #40 Embedding Init (blocked)

### Updated Recommended Implementation Order

**Wave 1 — Critical Fixes & Quick Wins (1-2 days each):**
1. #41 Fix Guilt Repair Dead Path — critical bug, high impact
2. #42 Live ageWeight Decay — correctness critical
3. #26 Per-Row Error Isolation — prevents data loss
4. #25 LLM Timeout Guards — prevents permanent cycle blocking
5. #38 Configurable Pricing — 30 min, zero risk
6. #43 Bootstrap Normalization — quick correctness fix
7. #16 Stale Comment Cleanup — documentation hygiene

**Wave 2 — Reliability & Performance (2-3 days each):**
8. #27 Jitter/Iterative Retry — resilience improvement
9. #29 Perception Timeout Guards — prevents hangs
10. #33 Neo4j Session Batching — performance + code cleanliness
11. #39 Parallel Simulation — direct latency improvement
12. #36 Tick Loop Observability — enables diagnosis

**Wave 3 — Observability & Operations (3-4 days each):**
13. #30 Supervisor Audit Trail — enables historical analysis
14. #34 Adaptive Sampling — cost optimization
15. #18 Drive Events to TimescaleDB — completes event backbone
16. #19 Drives Controller Endpoints — enables external control

**Wave 4 — Intelligence Quality (3-5 days each):**
17. #32 Windowed Sampling — fixes reflection blind spots
18. #23 Cross-Drive Aggregation — richer simulation
19. #28 Adaptive Scoring — learning from outcomes
20. #24 Theater Prohibition — authenticity validation
21. #31 Insight Re-grounding — knowledge quality

**Wave 5 — Architecture (5+ days each):**
22. #35 Decision Cycle Concurrency Guard — critical but complex
23. #44 Sidecar Circuit Breaker — production resilience
24. #20 IPCSelfKgReader — core architecture
25. #21 Morphology 'call' Step — feature completion
26. #22 SensoryLogger Removal — cleanup after executor wiring
27. #37 Semantic Extraction — after outcome data flow verified

**Wave 1 Additions (2026-04-13):**
28. #45 getSplitHistory() Cache — trivial quick win, < 1 day, no dependencies

**Wave 4 Additions (2026-04-13):**
29. #46 Mood-Congruent Episodic Retrieval — 3-4 days, benefits from #42 (ageWeight decay) being done first; pairs naturally with #23 (Cross-Drive Aggregation) and #28 (Adaptive Scoring)

**No Action:**
- #17 Attractor Detectors — already implemented
- #40 Embedding Init — blocked on file access
