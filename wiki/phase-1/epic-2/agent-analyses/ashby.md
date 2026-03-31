# Epic 2 Analysis: The Event Backbone as Stigmergic Coordination Medium
**Ashby, Systems & Cybernetics Theorist**

---

## Executive Summary

Epic 2 implements the **real EventsService**—the TimescaleDB event backbone that serves as the stigmergic coordination medium for all five subsystems. From a systems-theoretic perspective, the event stream is not merely a logging mechanism. It is the **substrate through which loosely-coupled subsystems observe each other's behavior without direct dependencies**, enabling emergent coordination while preserving the architectural isolation that prevents reward hacking (Immutable Standard 6).

This analysis examines the event schema and query patterns for sufficiency under concurrent subsystem load, feedback loop coherence, information loss risks during temporal compression, and implications for the six known attractor states.

**Critical finding:** The event backbone is architecturally sound but has two information-capacity bottlenecks that could impair learning if Learning consolidation cycles fall out of sync with Drive Engine frequency aggregations. The 7-day compression window is conservative but creates a risk: unconsolidated events can be compressed before being processed, losing granularity needed for pattern detection.

---

## 1. Stigmergy as Architectural Pattern

### What is Stigmergy?

Stigmergy is indirect coordination through modification of a shared environment. The classic example is ant pheromone trails: ants do not communicate directly; they lay pheromones that other ants sense, creating emergent collective behavior without central coordination.

In Sylphie, the shared environment is **the event stream in TimescaleDB**. Each subsystem:
- **Writes** what it did (action executed, prediction made, drive snapshot, learning consolidation result)
- **Reads** what others did (Drive Engine queries event frequency; Learning reads "has_learnable" events)
- **Never directly calls** other subsystems' methods

This decoupling has two benefits:
1. **Modularity:** Subsystems can be tested in isolation; failure in one doesn't cascade through synchronous calls
2. **Causality coherence:** Events carry timestamps, allowing causal reconstruction without assuming synchronous message passing

### The Stigmergic Medium Must Carry Sufficient Cues

For stigmergy to work, the environmental modifications (events) must contain enough information for each subsystem to make decisions. Too sparse, and subsystems can't coordinate. Too rich, and the bandwidth overhead becomes intolerable.

**Ashby's Law of Requisite Variety (1956):** A regulator can only control a system if its internal variety (information capacity) matches the system's disturbance variety.

Applied here: the event schema's **variety** (distinct event types, fields, discriminators) must be sufficient for each subsystem to distinguish the situations it needs to handle.

---

## 2. Stigmergic Sufficiency Analysis

### The Five Read-Paths Through Events

Each subsystem queries TimescaleDB for different purposes:

#### Decision Making
**Writes:** `PREDICTION_GENERATED`, `INPUT_RECEIVED`, `ACTION_SELECTED`, `OUTCOME_OBSERVED`
**Reads:** Self episodes (via Episodic Memory); prediction outcomes for confidence updates

**Stigmergic cue requirement:** The event must carry enough context for Decision Making to understand what happened *in the world*, not just what the system did. Without this, confidence updates become self-validating ("I predicted X, outcome says X, so I was right") rather than predictive.

**Risk:** If outcome events lack sufficient context (e.g., no `environment_state_delta` or `guardian_correction_flag`), Decision Making cannot distinguish:
- "I predicted correctly because my model is good" (learn: reinforce Type 1)
- "I predicted correctly by accident" (learn: no change or decay confidence)
- "I predicted correctly but the guardian corrected me anyway" (learn: my model was wrong, but luck made it seem right)

**Mitigation:** `OUTCOME_OBSERVED` events must include `prediction`, `actual`, `guardian_correction`, `drive_valence_change`.

#### Drive Engine
**Writes:** `DRIVE_STATE_SNAPSHOT`, `OPPORTUNITY_DETECTED`, `RULE_EVALUATED`
**Reads:** Recent event frequency (last 10 events per type); event timestamps for rule timing conditions

**Stigmergic cue requirement:** Frequency aggregations alone are sparse. Drive Engine needs to know *when* events occurred and their correlation.

**Risk:** If Drive Engine only sees "5 PREDICTION_FAILURE events in last 10 minutes," it can't distinguish:
- Five independent failures (genuine pattern, create Opportunity)
- Five bursts of one failure (same action failing repeatedly, different pattern)
- Five in rapid succession (possible cascade/cascade failure)

**Mitigation:** `PREDICTION_FAILURE` events must carry `prediction_context`, `environment_context`, `consecutive_count` or timestamp granularity must be fine enough for Drive Engine to group them post-query.

#### Learning
**Writes:** `CONSOLIDATION_CYCLE_START`, `ENTITY_EXTRACTED`, `EDGE_REFINED`, `LEARNABLE_MARKED`
**Reads:** Events with `has_learnable=true` (max 5 per cycle, to prevent catastrophic interference)

**Stigmergic cue requirement:** Learning needs to know *why* an event is learnable. A conversation event is learnable if it teaches something about entities/relationships. A prediction event is learnable if it produces a prediction error.

**Risk:** If `has_learnable=true` is set by the event-generating subsystem (e.g., Decision Making marks its own predictions as learnable), there's a **tight coupling** between what Decision Making thinks is learnable and what Learning actually needs to consolidate. A buggy Decision Making could flood Learning with junk.

**Mitigation:** `has_learnable` should be set by a Policy Service that reads events and applies domain rules: "prediction_failure_magnitude > 0.15 → has_learnable=true", "communication_event with new_entity → has_learnable=true", etc.

#### Planning
**Writes:** `PLAN_CREATED`, `PLAN_EXECUTED`, `PLAN_FEEDBACK`
**Reads:** Event frequency patterns for Opportunities (recurring prediction failures, high-impact single failures)

**Stigmergic cue requirement:** Planning needs to reconstruct **causal chains** from events. "Action X led to Outcome Y, which triggered Opportunity Z." Without causal linkage (correlation IDs, parent/child event pointers), Planning sees a flat stream and can't detect patterns.

**Risk:** If events lack `correlation_id` or `parent_event_id`, Planning cannot reconstruct which prediction failures are linked to which actions. It may create plans for spurious patterns (false positives) or miss genuine causal chains.

**Mitigation:** All events must carry `correlation_id` for traceability; `OUTCOME_OBSERVED` must reference `prediction_event_id` or similar.

#### Communication
**Writes:** `COMMUNICATION_EVENT`, `UTTERANCE_GENERATED`, `RESPONSE_RECEIVED`, `SOCIAL_COMMENT_QUALITY`
**Reads:** Own events for conversational context; person model context (via Other KG, not events)

**Stigmergic cue requirement:** Communication needs temporal context to understand conversation state. "Guardian just said X" is different from "Guardian said X 30 minutes ago."

**Risk:** If `COMMUNICATION_EVENT` lacks precise timestamp or `parent_utterance_id`, the Communication system can't accurately compute the `SOCIAL_COMMENT_QUALITY` metric (guardian response within 30s yields extra reinforcement). False timestamps lead to false metric values, corrupting drive contingencies.

**Mitigation:** Timestamps must be UTC, precise to milliseconds. `UTTERANCE_GENERATED` must carry `spoken_by`, `time_generated`, `correlation_id`.

### Sufficiency Verdict

The described event schema *appears* sufficient IF:
1. **Every event carries correlation context** (correlation_id, parent references, cause chains)
2. **Outcome events are rich** (prediction, actual, delta, correction flag)
3. **has_learnable is policy-driven**, not self-reported by event generators
4. **Timestamps are microsecond-precise** (to avoid ambiguity in fast loops)

---

## 3. Feedback Loop Mapping Through the Event Backbone

### Fast Loop: Decision-Action-Evaluation (< 500ms latency)

```
[Decision Making]
      ↓
ACTION_SELECTED event → TimescaleDB
      ↓
[Executor executes; world responds]
      ↓
OUTCOME_OBSERVED event → TimescaleDB
      ↓
[Drive Engine reads OUTCOME, evaluates prediction]
      ↓
Drive state updates (via IPC)
      ↓
[Decision Making reads new drive state]
```

**Timescale:** Real-time. Single decision cycle. Latency: 10-100ms in the common case.

**Loop character:** **Negative (stabilizing) if outcomes are accurate; positive (destabilizing) if outcomes are noisy.**

**Risk:** If OUTCOME_OBSERVED events have measurement noise (guardian misinterprets Sylphie's intent, outcome reported incorrectly), the negative feedback becomes positive. The system learns to do things that *appear* successful but aren't actually solving the underlying problem.

**Limiting mechanism:** The Guardian Asymmetry (Immutable Standard 5). When guardian explicitly corrects (`GUARDIAN_CORRECTION` event with 3x weight), it overrides algorithmic evaluation. This resets the loop's baseline.

### Medium Loop: Frequency Aggregation & Opportunity Detection (5-60s latency)

```
[Multiple ACTION_SELECTED/OUTCOME events in TimescaleDB]
      ↓
[Drive Engine tick: query event frequency]
      ↓
Recurring failures detected (> 3 in window) → Opportunity created
      ↓
OPPORTUNITY_DETECTED event → TimescaleDB
      ↓
[Planning reads opportunity; researches patterns]
      ↓
PLAN_CREATED event → TimescaleDB
      ↓
[Decision Making retrieves plan as Type 1 candidate]
```

**Timescale:** Seconds to minutes. Detection lag is bounded by Drive Engine tick frequency.

**Loop character:** **Positive (amplifying) under poor conditions, negative (damping) under good.**

- Positive when: failures are genuine and recurring. The system creates plans to handle them. This is growth.
- Positive pathologically when: false positives (random noise → "opportunity" → useless plan creation). This is the **Planning Runaway** attractor state.

**Limiting mechanism:** Opportunity priority queue with decay. Unaddressed Opportunities lose priority. Rate limiting on plan creation. Cold-start dampening (early prediction failures have reduced weight).

### Slow Loop: Learning Consolidation (5+ minutes latency)

```
[Events with has_learnable=true accumulate in TimescaleDB]
      ↓
[Learning: maintenance cycle triggers]
      ↓
Query max 5 learnable events
      ↓
LLM-assisted extraction + contradiction detection
      ↓
ENTITY_EXTRACTED, EDGE_REFINED events → TimescaleDB + Neo4j WKG
      ↓
[Decision Making: next retrieval pulls newly-reinforced knowledge]
```

**Timescale:** Minutes to hours. Bounded by maintenance cycle frequency (pressure-driven or timer).

**Loop character:** **Positive (amplifying) through successful consolidation.**

Each learnable event that consolidates increases WKG confidence. Higher confidence shifts more decisions to Type 1. More Type 1 decisions reduce Type 2 cost, freeing capacity for new learning. This is virtuous.

**Limiting mechanism:** Confidence ceiling (Immutable Standard 3). No knowledge > 0.60 without retrieval-and-use. This prevents a "lucky extraction" from becoming overconfident.

### Feedback Loop Summary

| Loop | Latency | Character | Limiting Mechanism |
|------|---------|-----------|-------------------|
| Fast | <500ms | Neg if accurate, Pos if noisy | Guardian Asymmetry |
| Medium | 5-60s | Pos (growth) / Pos path. (runaway) | Opportunity decay + rate limiting |
| Slow | 5+ min | Pos (learning) | Confidence ceiling |

**Coherence assessment:** The three loops are **loosely coupled but coherent**. They operate on different timescales and read different aspects of the event stream. Cross-talk is minimized. This is good for modularity but creates a risk: **synchronization failure** (see Section 5).

---

## 4. Information Dynamics: Compression and Loss

### Temporal Compression at 7 Days

The event backbone has a retention policy:
- **Live (< 7 days):** Full granularity, no compression
- **Aged (7-90 days):** Compressed (aggregated counts, summary statistics)
- **Expired (> 90 days):** Deleted

### Why Compression is Necessary

TimescaleDB is optimized for high-write throughput. Without compression, storage grows without bound. With 5 subsystems each emitting 100-1000 events/minute at peak load, uncompressed retention would consume terabytes in weeks.

### The Information Loss Risk

**Critical:** Learning consolidation cycles may produce learnable events that are not processed before the 7-day compression window closes.

**Scenario:**
1. Day 0, 10:00: Prediction failure occurs → `PREDICTION_FAILURE` event created with `has_learnable=true`
2. Day 0-6: Learning is busy consolidating other events (max 5 per cycle); the prediction failure event stays in the queue
3. Day 7, 00:00: Compression triggers; fine-grained event is aggregated into histogram ("5 PREDICTION_FAILURE events in day 7")
4. Day 7, 14:00: Learning finally gets around to consolidating the original event — but it's been compressed, and the original `environment_context`, `prediction_content`, etc. have been discarded
5. Learning sees the histogram but can't reconstruct the specific failure pattern; opportunity for learning is lost

**Impact:** The WKG grows more slowly than it should. Type 1 coverage doesn't develop as expected. The system stays Type 2-dependent longer than intended.

**Probability:** Not negligible. If Learning consolidation cycles are infrequent (e.g., every 30 minutes under pressure), and peak event load is high (1000 events/min), a backlog of unconsolidated learnable events will accumulate.

### Mitigation Strategies

**Option 1: Prioritize learnable events**
- Queries for learnable events run with `ORDER BY priority DESC, created_at ASC`
- Prediction failures are HIGH priority; communication events are MEDIUM; system health is LOW
- Learning processes high-priority events first, reducing backlog

**Option 2: Extend the granular window**
- Keep full granularity for 14 days (more storage, but manageable)
- Reduces the window where unconsolidated events are at risk
- Trade storage cost for learning fidelity

**Option 3: Soft compression (no aggregation)**
- Compress at 7 days but keep all fields (smaller index, smaller footprint)
- No information loss; only performance degradation for very old queries
- Best option if storage allows

**Option 4: Conditional consolidation**
- On each Learning cycle, if there are unconsolidated learnable events > 7 days old, process them *first* before accepting new learnable events
- Prevents backlog accumulation
- Requires Learning to track event age

**Recommendation:** Implement Option 1 + Option 4. Prioritize learnable events at the query level. Implement a "consolidation debt" alarm: if unconsolidated learnable events are approaching 7 days old, trigger an emergency consolidation cycle.

---

## 5. Coupling Analysis: Subsystem Interactions via Events

### Coupling Tightness

Subsystems interact via the event stream. The tightness of coupling is determined by:
1. **Frequency of reads** (how often does subsystem A query subsystem B's events?)
2. **Dependency on freshness** (does stale data break the subsystem?)
3. **Feedback loops** (does A's events affect B's future behavior, which affects A's next decision?)

### Coupling Matrix

| From \ To | DM | Comm | Learn | Drive | Plan |
|-----------|-----|-------|-------|-------|------|
| **DM** | - | Reads outcomes for confidence | Writes predictions for consolidation | Reads drive snapshots for arbitration | N/A |
| **Comm** | N/A | - | Writes interaction events | Reads drive state for context | N/A |
| **Learn** | Writes extracted edges (via WKG, not events) | Writes to WKG | - | Detects prediction failures | N/A |
| **Drive** | Reads outcomes | Reads interaction events | N/A | - | Writes opportunities |
| **Plan** | Reads prediction failures for patterns | N/A | N/A | Reads drive state | - |

**Coupling assessment:**

- **DM ↔ Drive:** Tight. Drive state changes every 100ms; DM reads at every decision cycle. This is a real-time feedback loop. Latency > 500ms breaks arbitration (Type 1/Type 2 decision uses stale drive state).

- **Learn → WKG → DM:** Loose. Learning writes to Neo4j (not events); Decision Making reads from Neo4j asynchronously. No strict latency requirement.

- **DM → Drive (outcomes):** Loose to medium. Drive Engine queries events in batches (frequency aggregation every 10s). Individual outcome delays don't break the loop.

- **Drive → Plan (opportunities):** Loose. Plan creation is asynchronous; stale opportunities are deprioritized.

### Cascading Failure Analysis

**Question:** If TimescaleDB goes down, what breaks immediately?

1. **Decision Making:** Still compiles. Can't record predictions or outcomes. After ~1 minute, can't retrieve decision outcomes for confidence updates; Type 1/Type 2 arbitration becomes conservative (defaults to Type 2 for safety).

2. **Drive Engine:** Can't query event frequency. Opportunity detection stops. Drives tick from rules and self-evaluation only. System continues but becomes reactive (no planning).

3. **Learning:** Can't query learnable events. Consolidation stops. WKG stops growing. Decision Making's future retrievals return stale knowledge.

4. **Planning:** Can't research opportunity patterns. Doesn't crash, but becomes ineffective.

5. **Communication:** Can't record interaction events. Response generation continues (uses WKG, drive state). But no history, so person modeling degrades over time.

**Verdict:** No cascading failure. Subsystems degrade gracefully. The system is resilient to TimescaleDB outage, though learning stops.

### Cascade Risk Under High Load

If all 5 subsystems write events concurrently at peak load, could TimescaleDB throughput become the bottleneck?

**Math:** 5 subsystems × 100-1000 events/min each = 500-5000 events/min peak. TimescaleDB can handle millions of writes/min. Not a bottleneck.

**Risk:** Not throughput, but **query contention**. If Learning and Drive Engine both query frequency aggregations simultaneously, competing for hot index pages, latency spikes. Planning simultaneous queries could add 100-500ms latency to each read.

**Mitigation:** Use separate read replicas for Analytics (Learning, Planning) vs. Real-time (Drive, Decision). Or implement query rate limiting on Learning/Planning to prevent overload on Drive Engine's critical path.

---

## 6. Attractor State Implications

### Type 2 Addict

**Mechanism:** LLM always wins arbitration; Type 1 never develops.

**Event backbone role:** Tracks the ratio of Type 1 vs. Type 2 decisions via `DECISION_SELECTED` events (which should carry `decision_type: "TYPE_1" | "TYPE_2"`).

**Early warning:** Query `SELECT COUNT(*) FROM events WHERE event_type='DECISION_SELECTED' AND data->>'decision_type'='TYPE_2'` over rolling 1-hour windows. If ratio stays >95% TYPE_2, trigger alert.

**Prevention:** Without the event backbone, we'd have no observability into this ratio. The Events Module is **essential for detecting Type 2 Addict** before it becomes entrenched.

### Hallucinated Knowledge

**Mechanism:** LLM generates plausible but false entities/edges during Learning; positive feedback amplifies them.

**Event backbone role:** Learning emits `ENTITY_EXTRACTED` and `EDGE_REFINED` events with provenance tag. Events carry `source: "LLM_GENERATED"`, `base_confidence: 0.35`.

**Early warning:** Query events with `source="LLM_GENERATED"` and track their eventual success rate. If LLM-generated nodes frequently contradict later guardian corrections, trigger learning system review.

**Prevention:** The Event backbone allows post-hoc analysis of which subsystem generated which knowledge and how it performed. Without events, we'd only know after a full lesion test.

### Planning Runaway

**Mechanism:** Too many prediction failures → many Opportunities → many Plans → resource exhaustion.

**Event backbone role:** Tracks `PLAN_CREATED` and `PLAN_EXECUTED` events. Rate limiting logic queries recent plan frequency.

**Explicit monitoring:**
```sql
SELECT COUNT(*) FROM events
WHERE event_type='PLAN_CREATED'
  AND created_at > NOW() - INTERVAL '1 hour'
```
If count > threshold (e.g., 50 plans/hour), trigger rate-limit enforcement.

**Prevention:** Without the event backbone, the Planning system would have to self-monitor (risky). With events, external monitors can detect runaway and throttle gracefully.

### Depressive Attractor

**Mechanism:** Negative self-model → low Satisfaction + high Anxiety → failures → more negative self-model.

**Event backbone role:** Emits `SELF_EVALUATION_EVENT` (reads Self KG, updates baseline drives). Events carry self-model sentiment: `self_valence: -0.8`.

**Early warning:**
```sql
SELECT AVG(data->>'self_valence') FROM events
WHERE event_type='SELF_EVALUATION_EVENT'
  AND created_at > NOW() - INTERVAL '30 minutes'
```
If average < -0.6 for sustained period, trigger circuit breaker: pause self-evaluation updates, reset to neutral baseline.

**Prevention:** Event backbone provides ground truth for system's self-perception over time. Without it, we'd only know something's wrong when behavior completely stops.

### Prediction Pessimist

**Mechanism:** Early prediction failures flood system with low-quality procedures before the graph has substance.

**Event backbone role:** Tracks `OPPORTUNITY_DETECTED` and `PLAN_CREATED` events early in the session.

**Explicit prevention:**
- Cold-start dampening: for first 100 decision cycles, reduce Opportunity generation weight by 50%
- Query events: `SELECT COUNT(*) FROM events WHERE event_type='DECISION_CYCLE'` to count cycles
- When count < 100, apply dampening

**Prevention:** The Event backbone provides the ground truth for "how many cycles have we run?" without relying on a separate counter.

### Rule Drift

**Mechanism:** Self-generated drive rules slowly diverge from design intent.

**Event backbone role:** Emits `RULE_PROPOSED` and `RULE_EVALUATED` events (Drive Engine side). Events carry `rule_id`, `performance_delta`, `timestamp`.

**Monitoring:**
```sql
SELECT rule_id, AVG(data->>'performance_delta') as avg_delta
FROM events
WHERE event_type='RULE_EVALUATED'
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY rule_id
HAVING avg_delta < -0.1
```
If a proposed rule consistently underperforms, flag it for review (not auto-delete; guardian decides).

**Prevention:** Without events, rule performance would be invisible. With events, drift is detectable and actionable.

---

## 7. Emergence Conditions: Whole-System Properties Observable in Events

### What Properties Should Emerge from the Event Stream?

The event stream should reveal patterns that are *not* observable from any single subsystem:

#### 1. **Behavioral Diversity Index**
No single subsystem tracks "how many different action types has Sylphie executed in the last 20 decisions?" Learning only consolidates knowledge; Drive only fires drives; Decision only selects actions.

But the **event stream can compute this**:
```sql
SELECT COUNT(DISTINCT data->>'action_type')
FROM events
WHERE event_type='ACTION_SELECTED'
  AND created_at > NOW() - INTERVAL '1 hour'
```

Healthy range: 4-8 distinct action types per 20-action window. Below 4 = behavioral narrowing (red flag). Above 8 = chaotic/unsustainable.

#### 2. **Type 1 Competence (via Graduated Actions)**
No subsystem sees "the ratio of Type 1 decisions that succeeded vs. those that failed." Decision Making executes Type 1; Drive Engine evaluates outcomes; but neither sees the graduation rate.

Event stream computation:
```sql
SELECT
  COUNT(CASE WHEN d.decision_type='TYPE_1' THEN 1 END) as type1_count,
  COUNT(CASE WHEN d.decision_type='TYPE_1' AND o.outcome='SUCCESS' THEN 1 END) as type1_success
FROM decision_selected d
LEFT JOIN outcome_observed o ON d.correlation_id=o.prediction_correlation_id
WHERE d.created_at > NOW() - INTERVAL '10 decisions'
```

Healthy trend: Type 1 success ratio increases over sessions (>70% after 100 cycles).

#### 3. **Prediction-Learning Lag**
Learning doesn't see "how long does a prediction failure stay unconsolidated before becoming knowledge?" Drive Engine doesn't see "how many prediction failures are currently waiting for consolidation?"

Event stream computation (using correlation IDs):
```sql
SELECT AVG(EXTRACT(EPOCH FROM (l.created_at - p.created_at))) as lag_seconds
FROM prediction_failure p
LEFT JOIN entity_extracted l ON p.correlation_id=l.prediction_correlation_id
WHERE p.created_at > NOW() - INTERVAL '24 hours'
```

Healthy range: median lag < 30 minutes. If > 60 minutes, consolidation is bottlenecked.

#### 4. **Drive Entropy (behavioral flexibility)**
No single subsystem knows "how evenly distributed are Sylphie's decisions across drives?" If one drive is always activated, the system is narrowly motivated.

Event stream computation:
```sql
SELECT
  data->>'dominant_drive' as drive,
  COUNT(*) as count
FROM decision_cycle
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY data->>'dominant_drive'
```

Compute entropy: -Σ(p * log(p)). Healthy range: entropy > 2.5 bits (out of max 3.58 for 12 drives). Below 2.0 = one drive dominates.

#### 5. **Guardian-System Synchrony (via Comment Quality)**
No subsystem sees "did the guardian respond to Sylphie's social comment, and did it improve Sylphie's Satisfaction drive?" Communication generates comments; Drive Engine updates drives; but neither sees the causal chain.

Event stream computation:
```sql
SELECT
  COUNT(CASE WHEN response_time_ms < 30000 THEN 1 END) as quick_responses,
  COUNT(*) as total_comments
FROM utterance_generated u
LEFT JOIN message_received m ON u.correlation_id=m.comment_correlation_id
WHERE u.created_at > NOW() - INTERVAL '24 hours'
```

Healthy: >50% of comments receive response. >70% = Sylphie is engaging; <30% = disengagement.

### Emergence Verdict

The event backbone enables **meta-level monitoring** that would require either:
1. Coupling subsystems directly (bad architecture)
2. Post-hoc analysis of Neo4j + PostgreSQL + TimescaleDB (fragile, slow)

With a coherent event stream, emergence is **observable, measurable, and actionable**.

---

## 8. Risks and Recommendations

### Risk 1: Event Schema Drift

**Severity:** High
**Mechanism:** As subsystems evolve, they add new fields to events. New consumers of those events assume the fields exist. Refactoring removes fields; old consumers break.

**Example:** Decision Making starts including `raw_sensory_input` in `PREDICTION_GENERATED`. Planning reads it to improve simulation fidelity. Later, during optimization, Decision Making stops including it. Planning's simulation quality degrades without warning.

**Recommendation:**
- Define a **strict schema versioning policy**. Every event type has a `schema_version` field.
- When adding optional fields, bump minor version (e.g., 1.0 → 1.1). Consumers must handle missing fields gracefully.
- When removing mandatory fields, bump major version (e.g., 1.0 → 2.0). Require all consumers to update.
- Maintain a `schema_migrations.ts` file documenting all versions and required consumer updates.

### Risk 2: Synchronization Failure Between Loops

**Severity:** High
**Mechanism:** The three feedback loops (fast, medium, slow) operate on different timescales. If one subsystem falls out of sync, the system can enter incoherent states.

**Example:** Learning stalls (maintenance cycle not triggering frequently enough). WKG growth slows. Decision Making has fewer Type 1 candidates. Decisions revert to Type 2. Type 2 cost (latency + tokens) increases. Drive Anxiety rises (due to cost pressure). System becomes conservative. Eventually, all decisions are Type 2. Learning never consolidates enough to revive Type 1. System becomes stuck.

**Recommendation:**
- Implement **loop health monitoring**. Every 10 decision cycles, emit a `SUBSYSTEM_HEALTH_CHECK` event for each loop:
  - Fast: Did drive state update within 500ms?
  - Medium: Did Drive Engine query events successfully?
  - Slow: Did Learning run in the last 30 minutes?
- If a loop is unhealthy, trigger escalation:
  - Fast fails → pause all decisions (safety)
  - Medium fails → disable Planning (graceful degradation)
  - Slow fails → alert but continue (learning will resume when fixed)

### Risk 3: Unconsolidated Event Accumulation

**Severity:** Medium
**Mechanism:** Learning falls behind. Learnable events queue up. 7-day window closes. Events get compressed. Opportunities for learning are lost.

**Recommendation:** (See Section 4)
- Prioritize learnable events at query level
- Implement "consolidation debt" alarm
- Extend granular window to 14 days if storage allows
- Monitor unconsolidated event age continuously

### Risk 4: Event Timestamp Precision Under Load

**Severity:** Medium
**Mechanism:** When the system is under peak load, timestamps from different subsystems may have microsecond skew. This breaks causal ordering assumptions.

**Example:** Decision Making emits `ACTION_SELECTED` at T=1000.00001. Drive Engine evaluates outcome at T=1000.00002. But if Drive Engine's clock drifts, outcome might be recorded at T=999.99999, appearing to precede the action.

**Recommendation:**
- Use a **monotonically increasing logical clock** (Lamport timestamps) instead of wall clock timestamps for causal ordering
- Store both: `wall_clock_timestamp` (for human readability, temporal queries) and `logical_timestamp` (for causal reconstruction)
- Queries that depend on causal order use logical timestamps; temporal range queries use wall clock

### Risk 5: Query Performance Degradation

**Severity:** Medium (at scale)
**Mechanism:** Learning and Planning frequently query TimescaleDB. Drive Engine queries every 100ms. If query latency degrades, the critical path (Drive Engine's loop) gets blocked.

**Recommendation:**
- Index aggressively: `(event_type, created_at DESC)`, `(subsystem_source, event_type)`, `(correlation_id)`
- Separate read replicas for non-critical queries (Learning, Planning)
- Implement query timeouts: critical (Drive, Decision) = 50ms; non-critical (Learning, Planning) = 5s
- Monitor query latency per subsystem; alert if critical path queries exceed 100ms

### Risk 6: Information Capacity Mismatch

**Severity:** Low to Medium
**Mechanism:** If the event schema is too sparse, subsystems can't distinguish important situations. If too rich, overhead becomes intolerable.

**Recommendation:**
- Maintain a **Stigmergic Cue Checklist** for each subsystem:
  - **Drive Engine:** needs `event_type`, `timestamp`, `correlation_id`, `outcome_magnitude`, `context_delta`
  - **Learning:** needs everything above plus `raw_content`, `entities_mentioned`, `entities_implied`
  - **Planning:** needs causal chains via `parent_event_id`, `correlation_id`
  - **Communication:** needs `speaker_id`, `time_utc`, `correlation_id`
- During epic planning, validate: "Can subsystem X answer its decision questions from the event schema?"

---

## 9. Systems-Theoretic Verdict

### Sufficient Variety?

**Ashby's Law:** The event schema provides sufficient variety to distinguish most situations each subsystem needs to handle, *conditional on* the mitigations in Section 8.

**Risk level:** Medium-high if recommendations are ignored; low if implemented.

### Coherence?

The three feedback loops (fast, medium, slow) are loosely coupled but **coherent in phase** — each operates on a different timescale, reducing cross-talk. This is architectural strength.

**Risk level:** Low if loop health monitoring is implemented.

### Resilience?

The system degrades gracefully if TimescaleDB is unavailable. No component depends on events for basic functionality; events are the **observation channel**, not the **control channel**.

**Risk level:** Low.

### Learning Capacity?

The event backbone enables the learning loops (slow and medium) to operate. Without it, Sylphie would be a non-learning system.

**Verdict:** The event backbone is **architecturally critical** and **essential for personality emergence through contingency**. Get it right, and the system learns. Get it wrong, and the system becomes a static chatbot.

---

## 10. Implementation Priorities for Epic 2

1. **Schema versioning and migrations** (prevent Risk 1)
2. **Logical timestamps + wall-clock timestamps** (prevent Risk 4)
3. **Learnable event prioritization + consolidation debt alarm** (prevent Risk 3)
4. **Loop health monitoring** (prevent Risk 2)
5. **Query indexing strategy** (prevent Risk 5)
6. **Stigmergic cue checklist validation** (prevent Risk 6)

**Recommended order:** Schema design first (foundational); then indexing; then health monitoring; then the mitigations.

---

## References

- Ashby, W. R. (1956). *An Introduction to Cybernetics*. Chapman & Hall. [Requisite Variety, feedback loops]
- Campbell, D. T. (1976). Assessing the impact of planned social change. *Public Affairs Center, Dartmouth College*. [Campbell's Law, metric corruption]
- Stigmergy: Theraulaz, G., & Bonabeau, E. (1999). A brief history of stigmergy. *Artificial Life*, 5(2), 97–116.
- ACT-R confidence dynamics: Anderson, J. R. (2007). *How Can the Human Mind Occur in the Physical Universe?* Oxford University Press.
