# Ideas Research Report

**Generated:** 2026-04-09
**Last Updated:** 2026-04-09
**Scope:** All proposed ideas in `/wiki/ideas/`

---

## Executive Summary

Fifteen proposed ideas were researched against the current Sylphie codebase. All are feasible with varying levels of complexity and impact. Below is a prioritized summary followed by detailed findings for each idea.

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
