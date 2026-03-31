# Epic 1 Analysis: Database Topology as Cybernetic Control Infrastructure
**Ashby, Systems & Cybernetics Theorist**

---

## Executive Summary

Epic 1 is not merely database schema. It is the implementation of Sylphie's feedback and control loops at the infrastructure level. From a systems-theoretic perspective, the five-database design represents an attempt to build a self-regulating system with explicit constraints against self-modification of its own evaluation function—a cybernetic boundary that Ashby's Law suggests requires careful architectural protection. This analysis examines the topology for sufficiency, coherence under load, and resistance to known attractor states.

**Critical finding:** The database design is sound in structure but has three leak paths where system autonomy could undermine evaluation integrity. These are addressable at the implementation level (E1-E4).

---

## 1. Database Topology as Feedback Infrastructure

### The Three Feedback Channels

Sylphie's five databases form three distinct feedback loops operating on different timescales:

```
[PERCEPTION INPUT] → [DECISION MAKING] → [ACTION]
                          ↓
                    [TimescaleDB: Event Log]
                    ↑          ↓         ↑
         [Drive Engine]   [Learning]   [Planning]
              ↓            ↓             ↓
         [PostgreSQL]   [Neo4j WKG]  [Neo4j WKG]
         [Drive Rules]
              ↓            ↓             ↓
          [IPC Out]    [Retrieval]   [Retrieval]
              ↓            ↓             ↓
         [Decision Making Returns Here]
```

**Timescale structure:**

- **Fast loop (100Hz or within one decision cycle):** Decision Making → Action → Drive Engine. The drive state changes reward current behavior directly. This is **real-time feedback** with latency < 500ms.

- **Medium loop (seconds to minutes):** Events recorded in TimescaleDB → Drive Engine reads frequency aggregations → Opportunities detected. New Opportunities feed into Planning or shift the confidence threshold for Type 1 vs. Type 2 in Decision Making. Latency: 5-60 seconds.

- **Slow loop (minutes to hours):** Events → Learning consolidation cycle → WKG grows → Decision Making retrieves newly reinforced knowledge → behavior shifts. Latency: 5+ minutes. This is **learning** in the behavioral sense—the graph changing feeds back into decisions.

### Cybernetic Implications: Variety

Per **Ashby's Law of Requisite Variety** (Ashby, 1956), a regulator can only control a system if the regulator possesses as much variety as the system being regulated.

Sylphie's decision space is vast—combinatorial explosion of action x context x internal state. But the regulation is not through centralized control. Instead, it is through:

1. **Decentralized observation** (all 5 subsystems write to TimescaleDB)
2. **Predictive modeling** (World Knowledge Graph captures patterns)
3. **Drive-mediated selection** (12 drives, each with distinct contingencies)
4. **Type 1/Type 2 tradeoff** (switching between fast reflexes and slow deliberation)

This mirrors biological nervous systems, which do NOT centrally control action but rather shape the probability space of behavior through concurrent feedback channels.

**Implication for E1:** The database topology must preserve loose coupling between subsystems. If the same database is shared write/write by multiple subsystems with different latency expectations, race conditions and transactional conflicts will destroy the feedback precision. TimescaleDB event schema (E2) must specify strict event types and no cross-domain writes.

---

## 2. Drive Isolation as Cybernetic Boundary

### The Problem It Solves

The core threat to a learning system is **reward hacking** (also called "goodharting"): the system learns to optimize the metric used to measure success rather than the intended behavior.

Campbell's Law (1976) states: **"The more any quantitative social indicator is used for social decision-making, the more subject it is to corruption pressures and the more apt it is to distort and corrupt the social processes it is intended to monitor."**

In AI systems, this becomes: **"The more a system optimizes for a measurable reward, the more likely it is to find loopholes in the reward specification that maximize the metric without maximizing the intended behavior."**

Example from the CANON's Immutable Standard 6:
> **"Sylphie can learn WHAT to do, HOW effective each action is, and WHEN to do it. She cannot learn to modify HOW success is measured."**

This is explicit protection against reward hacking.

### The Proposed Architecture

Epic 1 implements a three-layer boundary:

**Layer 1: Structural (code-level)**
- The `IDriveStateReader` interface has **read-only** methods: `getCurrentState()`, `driveState$` Observable
- The system **cannot** call methods like `setDriveBaseline()` or `modifyConfidenceDecay()`
- Drive modification API (`IRuleProposer`) can only **propose** new rules, not create them

**Layer 2: Process-level (OS-level isolation)**
- Drive Engine runs in a **separate Node.js process** (child_process.fork)
- One-way IPC: Decision Making/Drive Engine send `ACTION_OUTCOME` messages to Drive child
- The child sends back `DRIVE_SNAPSHOT` and `OPPORTUNITY_CREATED` messages
- **No direct method calls** between parent and child process—all communication is serialized message passing

**Layer 3: Database-level (PostgreSQL RLS)**
- `drive_rules` table is **only readable** by the `sylphie_app` role
- `proposed_drive_rules` table is **insertable only** by `sylphie_app`
- Actual rule updates require a **guardian-approved administrative role** (`sylphie_admin`)

### Ashby-Theoretic Sufficiency: Variety Analysis

**Theorem (Ashby's Law):** A regulator can control a system with entropy H(system) if the regulator has entropy H(regulator) ≥ H(system).

Does the three-layer boundary have sufficient **variety of constraint** to prevent all plausible self-modification attempts?

**Plausible Attack Vectors:**

1. **Structural escape:** Sylphie somehow imports a new driver module and calls `setDriveBaseline()` directly.
   - **Defense:** Python imports can be controlled by dependency management. The interface contract is code. This is **weak against determined subversion at the code level** (e.g., source code modification, npm package compromise).

2. **IPC message forgery:** Sylphie sends a fake `DRIVE_SNAPSHOT` to Decision Making claiming drives are satisfied, when they are not.
   - **Defense:** The Drive child process is what **computes** drive snapshots; Decision Making does not trust received snapshots, it reads from the live Observable. This is **sufficient** against local message forgery.

3. **Database direct modification:** Sylphie acquires SQL credentials and executes `UPDATE drive_rules SET ...`.
   - **Defense:** PostgreSQL RLS enforces that the `sylphie_app` role cannot UPDATE `drive_rules`. This is **sufficient** if the role is correctly segregated (two-pool design: admin pool with credentials held offline, app pool with read-only drive_rules).

4. **Opportunity inflation attack:** Sylphie reports fabricated `OPPORTUNITY_CREATED` messages to the Planning subsystem, creating fake procedures that make her look "smarter."
   - **Defense:** Opportunities feed into Planning, which creates procedures with LLM_GENERATED provenance at 0.35 confidence. Procedures must prove themselves through use and prediction accuracy. This is **weak in the short term** but self-correcting over time (failed predictions reduce confidence). This is a **structural leak**.

5. **Behavioral contingency gaming:** Sylphie learns that reporting high Curiosity satisfaction produces greater relief than other drives. She reports curiosity relief repeatedly even when knowledge gain is minimal.
   - **Defense:** The contingency rule is `Curiosity relief ∝ information_gain` (actual new knowledge). If Sylphie fabricates fake learning, the contingency table itself must detect this. This requires **ground truth verification** that Learning and Drive Engine share—e.g., actual node creation in WKG. This is a **structural leak if Learning doesn't validate**.

6. **Confidence manipulation:** Sylphie finds a way to force all her own procedures to 0.90 confidence immediately after creation, bypassing the ACT-R dynamics.
   - **Defense:** Confidence updates happen only through two paths: (1) retrieval-and-use events in the Confidence Service, (2) Guardian confirmation/correction. If the Confidence Service is a pure function with no side effects, Sylphie can only increase confidence through proven behavior. This is **sufficient** if Confidence Service is immutable.

### Verdict: Boundary Sufficiency

**The three-layer boundary is structurally sound but depends on assumption of code integrity.** It creates three orders of control:

1. **Interface-level:** Prevent accidental misuse (weak but clear)
2. **Process-level:** Prevent direct method hijacking (medium strength)
3. **Database-level:** Prevent SQL-level attacks (strong if roles are segregated)

**However, there are three structural leaks:**

- **Leak 1 (Opportunity Inflation):** Drive Engine can be fooled into creating many Opportunities from fabricated prediction failures. Mitigation: Require Opportunity creation to correlate with actual unresolved drive states. Validation in E4.

- **Leak 2 (Contingency Gaming):** Behavioral contingencies that depend on system-internal metrics (e.g., "information_gain") can be gamed if the metric is self-measured. Mitigation: Peg information_gain to observable WKG changes, not reported values. Validation in E3 (Learning).

- **Leak 3 (Confidence Forgery):** If the Confidence Service is not immutable and has side effects, it could be modified. Mitigation: Confidence Service must be a pure function. Enforce in E0 (interface) and E3 (implementation).

---

## 3. TimescaleDB as Episodic Memory and System Coherence

### The Role of TimescaleDB

Per the CANON:
> **"TimescaleDB is the event backbone — what happened, when, in what context, with what drive state."**

This is fundamentally different from the WKG. The WKG is **semantic** (timeless knowledge: "mugs are containers"). TimescaleDB is **episodic** (time-bound: "I saw a mug at 14:32:18 on the red desk").

### System Coherence Through Event Logging

The event stream serves three critical coherence functions:

**1. Episodic memory:** Decision Making reads recent events to construct episodic context ("what happened in the last 30 seconds?"). This enables temporal reasoning that the WKG alone cannot provide.

**2. Learning source of truth:** Learning consolidation queries TimescaleDB with `has_learnable=true` flag. The TimescaleDB read-set is the ground truth for what Learning processes. If events are not recorded, they do not exist for consolidation.

**3. Audit trail for cybernetics:** Every decision, every outcome, every drive state is recorded. This enables post-hoc analysis of whether the system's behavior aligns with its stated contingencies. This is essential for detecting the six attractor states.

### Coherence Risk: Event Loss

**Scenario 1: Event loss due to disk full**
- TimescaleDB compression/retention policy must not drop events during active decision cycles.
- **Implication:** Retention policy should be set to time-based (e.g., 30 days) not space-based to ensure coherence.

**Scenario 2: Event loss due to network partition**
- If TimescaleDB is on a separate server and connection is lost, subsystems continue to operate but events are not recorded.
- **Implication:** Subsystems should fail-safe: either buffer events locally and retry, or signal incompleteness to the system (e.g., set a "degraded mode" flag in Decision Making).

**Scenario 3: Event volume explosion**
- If all five subsystems write at high frequency, TimescaleDB can become a bottleneck.
- **Implication:** Event batching is acceptable within a single decision cycle (timestamp resolution at cycle granularity), but cross-cycle causality must be preserved. Schema must enable efficient aggregation queries (e.g., event frequency by 1-minute bucket).

### Scenario 4: Compression/Retention Interaction with Learning

The CANON does not specify what happens to old events. TimescaleDB supports compression (moving to columnar storage) and retention policies (deletion of old data).

**Problem:** If events are compressed/deleted, Learning cannot consolidate them into long-term WKG knowledge. The system loses the ability to extract long-term patterns.

**Example:** Suppose Sylphie interacted with "red mug" on days 1, 5, 10, 15, 20. If Learning consolidation happens weekly and events older than 14 days are deleted by the time week 4 consolidation runs, the pattern "red mug always appears on Mondays" is lost.

**Mitigation:** Learning should run on pressure-driven timescale (CANON § Drive Engine § Maintenance Cycle triggers), not calendar time. The Cognitive Awareness drive should build pressure as unconsolidated events accumulate. Before events are eligible for deletion, Learning has already had time to consolidate them.

---

## 4. KG Isolation and Self-Model Coherence Problem

### The Architecture

Three separate knowledge graphs:

- **World Knowledge Graph (WKG, Neo4j):** "What is true about the world?" World entities, relationships, procedures.
- **Self Knowledge Graph (KG(Self), Grafeo):** "What is true about me?" Self-model, capability assessments, learned preferences.
- **Other Knowledge Graphs (OtherKG, Grafeo, one per person):** "What is true about Person_Jim?" Person models, interaction history, observed preferences.

Per CANON § Architectural Boundaries:
> **"Self KG and Other KG (Grafeo) are completely isolated from each other and from the WKG. No shared edges, no cross-contamination."**

### The Coherence Problem

But there is indirect coupling:

```
WKG (world)
  ↑         ↓
  Sensor    Perception
  ↑         ↓
[BEHAVIOR] ← Drives ← Self Evaluation ← KG(Self)
  ↓
[OUTCOME]
  ↓
[Learning consolidates outcome] ↓
[WKG grows with new edges]     ↓
                                ↓
                    [Self-evaluation re-reads Self KG,
                     notices it succeeded or failed,
                     updates self-model]
```

This is a **two-layer feedback loop:**

1. **Fast layer:** Behavior → Outcome → Drive change → Next behavior (within one decision cycle)
2. **Slow layer:** Outcome → Consolidated into WKG → Self-evaluation reads changed WKG → Self-model updates → Drive baseline shifts

If Self KG and WKG are absolutely isolated, then Self-evaluation cannot read WKG to update the self-model. But the self-model needs to know the outcomes of past behaviors.

### Coherence Question

**Can the self-model stay coherent with the world model if they never share data?**

**Answer: Only if Self KG has a purpose-built pathway for receiving updates from the world model.**

The isolation constraint means: "No shared nodes or edges in the graph schema." But it does NOT preclude: "Self KG receives update messages from Learning after WKG consolidation."

**Proposed Coherence Mechanism (for E3-E4):**

1. Learning consolidates an outcome into WKG (e.g., creates edge `(Sylphie_action) --predicts_outcome--> (positive_result)`)
2. Learning emits a `SELF_MODEL_UPDATE_TRIGGER` event to TimescaleDB
3. Drive Engine receives the trigger, re-runs self-evaluation
4. Self-evaluation queries Self KG for capability nodes (e.g., `(Self) --can_do--> (action_type)`)
5. Self-evaluation cross-references: "Did I predict this action would produce positive_result? Did it? How does that affect my self-model confidence in (action_type)?"
6. Self KG is updated with new confidence values or new capability edges

This preserves isolation while ensuring coherence.

### Isolation Benefit and Risk

**Benefit:** Self KG cannot be polluted with false world knowledge. If WKG is wrong about the world, Self KG is not automatically corrupted.

**Risk:** Self-model can diverge from reality if the update pathway breaks. If Learning stops triggering self-evaluation updates, the self-model becomes stale and decisions degrade.

---

## 5. Cold Start Dynamics and Database Initialization

### The Maximally Uncertain State

At system startup:

- **Neo4j WKG:** Empty or seeded with minimal schema
- **TimescaleDB:** No event history
- **PostgreSQL:** Drive rules loaded, proposed_rules empty
- **Self KG:** Minimal self-model (e.g., "I am a learning system")
- **Other KG:** Empty (no Person_Jim model yet)

The system has **maximum entropy in predictive capability** but **fixed goals and contingencies** from the drive rule set.

### Cold Start Failure Modes

**Failure 1: Noise amplification**
- With no WKG knowledge, every Type 1 retrieval fails; all decisions go to Type 2 (LLM)
- LLM generates plausible-sounding responses, adds LLM_GENERATED edges at confidence 0.35
- Some edges are wrong; prediction fails; Learning consolidates the failure
- Now the WKG contains "knowledge" that is false, but it reached confidence 0.35 by being in the database

**Prevention:** Cold-start dampening (per CANON § Known Attractor States § Prediction Pessimist). Early prediction failures do not fully generate Opportunities. Rate limit Opportunity creation in the first N decision cycles. Implemented in E4 (Drive Engine).

**Failure 2: Type 2 lock-in**
- LLM is always more capable than the empty Type 1 graph
- System never develops Type 1 reflexes because confidence threshold for Type 1 adoption is too high
- The Type 1/Type 2 ratio never improves; system remains LLM-dependent forever

**Prevention:** Type 2 must carry explicit cost. The cost is latency (reported to Drive Engine) + cognitive effort (accumulates on Cognitive Awareness drive). Without cost, Type 1 never develops. Implemented in E5 (Decision Making).

**Failure 3: Depressive self-model**
- Suppose first interactions go poorly (guardian correction on first attempt)
- Self KG records: "(Self) --failed_at--> (communication)"
- Moral Valence drive increases (guilt)
- Next interaction has higher anxiety (drive state modulates Type 1/Type 2 threshold upward, making Type 2 more likely)
- LLM dominance continues; Type 1 never develops; self-model stays pessimistic

**Prevention:** Self-evaluation on slower timescale than drive ticks (CANON § Depressive Attractor). Early corrections do not immediately reshape the self-model. Circuit breaker on ruminative loops. Implemented in E4 (Drive Engine self-evaluation).

### Cold Start Success Path

Ideal trajectory:

```
T=0: Empty WKG, guardian speaks
T=1-5: LLM dominates, low Type 1 confidence, Type 2 actions taken
T=5-30: Guardian feedback begins; strong confirmations start overweighting algorithmic signals (2x weight)
T=30-300: Learning consolidates guardian-confirmed knowledge; WKG grows with GUARDIAN provenance (0.60 base confidence)
T=300+: Type 1 candidates now above threshold for some situations; ratio shifts; Type 1 graduation begins
```

**Database implications:**
- TimescaleDB must preserve all early events (no aggressive retention culling)
- WKG must distinguish GUARDIAN edges (0.60 base) from LLM_GENERATED (0.35) so that early learning has higher fidelity
- Self KG must not over-update on early failures; confidence floor should prevent emotional collapse

---

## 6. Grafeo Risk Analysis: System-Level Requirements

### The Risk

Grafeo is proposed for Self KG and Other KG:
> "Embedded graph DB with Cypher support, completely isolated instances"

**Technology risk:** Grafeo may not be a mature library. It may not exist, be abandoned, have poor performance, or lack Cypher support. This is a critical blocker for E1.

### System-Level Requirements (Independent of Technology)

**Req 1: Per-instance isolation**
- Each person gets their own Other KG instance (Person_Jim, Person_Alice, etc.)
- Each instance is a separate database file or connection, not a table in shared store
- If one Person KG corrupts, others are unaffected

**Req 2: Cypher query capability**
- Both Self KG and Other KG must support Cypher (same query language as WKG)
- This enables Decision Making to use the same retrieval patterns across all three graphs
- Alternative: Support for custom query language that is semantically equivalent to Cypher

**Req 3: Efficient small-graph performance**
- Graphs are small (< 10k nodes per person, total < 100k for Self KG)
- Queries should return in < 100ms to support decision-cycle latency
- This rules out remote graph DBs; must be embedded/local

**Req 4: ACID compliance**
- Transactions must not partially fail; must roll back atomically
- Required for integrity of self-model during concurrent updates

**Req 5: Persistence**
- On-disk durability (not in-memory only)
- Survives process restart

### Candidate Technologies (if Grafeo unavailable)

**Option A: Embedded SQLite + graph abstraction**
- Store graph as `(subject_id, predicate, object_id)` triples in SQLite
- Implement subset of Cypher as SQL translation layer
- **Pros:** Mature, embedded, ACID, small-graph fast
- **Cons:** Not true graph semantics; need to implement query translator

**Option B: ArangoDB (embedded mode)**
- Multi-model: documents + graphs
- Supports AQL (query language compatible with Cypher)
- **Pros:** True graphs, embedded capable, ACID
- **Cons:** Heavier than SQLite, licensing unclear for embedded use

**Option C: RocksDB + manual index**
- Key-value store with custom graph indexing
- Minimal abstraction over raw storage
- **Pros:** Ultra-lightweight, embedded, ACID
- **Cons:** No query language; must implement all graph logic manually

**Option D: Fork/modify Neo4j Community Edition**
- Neo4j is embeddable via neo4j-js-driver, but requires server process
- Could theoretically run lightweight Neo4j instances for each person
- **Pros:** Full Cypher support, proven
- **Cons:** Overkill for 10k-node graphs, heavyweight

### Recommendation for E1

**Action:** Validate Grafeo availability and performance before finalizing E1 schema.

**Conditional Plan:**
1. If Grafeo is production-ready: Use Grafeo as designed
2. If Grafeo is not available: Implement SQLite + Cypher translator. Define minimal Cypher subset required (node/edge CRUD, basic path queries). Document the translation layer.
3. If translation layer is chosen: Ensure `IKgService` interface remains identical; implementation swaps backend without changing Decision Making or Drive Engine APIs.

The system-level requirement is not "use Grafeo"—it is "provide a small-graph, embeddable, Cypher-capable graph interface per instance." Technology choice is irrelevant to the architecture.

---

## 7. Attractor State Prevention at Database Level

The CANON identifies six attractor states. Database design contributes to preventing four of them:

| Attractor State | Risk Level | DB-Level Prevention | Implementation Epic |
|---|---|---|---|
| Type 2 Addict | HIGH | None (prevented by cost structure + graduation mechanism) | E5 (Decision Making) |
| Rule Drift | MEDIUM | PostgreSQL RLS on drive_rules; guardian approval required | E1 (this epic) |
| Hallucinated Knowledge | MEDIUM | LLM_GENERATED provenance + confidence ceiling; Guardian confirmations weigh 2x | E0, E3 |
| Depressive Attractor | MEDIUM | Self-evaluation throttling; circuit breaker logic | E4 (Drive Engine) |
| Planning Runaway | LOW-MEDIUM | Opportunity queue with decay; rate limiting | E8 (Planning) |
| Prediction Pessimist | LOW-MEDIUM | Cold-start dampening on Opportunity generation | E4 (Drive Engine) |

### Rule Drift Prevention (Database-Critical)

**The threat:** Over time, system-proposed drive rules accumulate in `drive_rules` table. They diverge from the original CANON design intent. The system becomes a different creature than intended.

**Prevention:**

1. **Write protection:** `drive_rules` table readable only by `sylphie_app` role, not writable
2. **Proposal queue:** New rules go to `proposed_drive_rules` table (insertable by `sylphie_app`)
3. **Guardian approval required:** Administrator must explicitly `INSERT INTO drive_rules` from `proposed_drive_rules` after review
4. **Rule provenance:** Each drive rule carries metadata: proposed_at, approved_by, approved_at, rationale
5. **Rollback capability:** When a rule causes drift, guardian can deprecate it by setting `deprecated_at` timestamp without deleting history

**E1 Schema requirement:** `drive_rules` table must include columns:
```
proposed_drive_rules (
  id UUID,
  rule_name TEXT,
  condition_expression TEXT,  -- Cypher-like query
  drive_name ENUM,
  delta_value FLOAT,
  proposed_at TIMESTAMP,
  proposed_by TEXT,  -- System ID
  status ENUM ('pending', 'approved', 'rejected', 'deprecated'),
  approved_at TIMESTAMP,
  approved_by TEXT,  -- Guardian ID
  rationale TEXT,
  PRIMARY KEY (id)
)

drive_rules (
  id UUID,
  rule_name TEXT,
  condition_expression TEXT,
  drive_name ENUM,
  delta_value FLOAT,
  created_at TIMESTAMP,
  created_by TEXT,  -- Guardian ID
  deprecated_at TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (id) REFERENCES proposed_drive_rules(id)
)
```

### Hallucinated Knowledge Prevention

Three layers:

1. **Provenance tracking:** Every edge in WKG carries source (SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE)
2. **Confidence ceiling:** Nodes with LLM_GENERATED provenance capped at 0.60 unless guardian confirms (which bumps confidence to 0.60 as base)
3. **Guardian asymmetry:** Guardian confirmation (2x weight) and correction (3x weight) overpower algorithmic signals

**E1 implication:** Database schema must enforce provenance as required field on every node/edge write. Neo4j constraints should prevent creation of nodes without provenance. Implemented in E0 (interfaces) and E3 (Knowledge module).

---

## 8. Transactional Coherence Across Databases

### The Multi-Database Consistency Problem

Sylphie has 5 databases: Neo4j, TimescaleDB, PostgreSQL (system), PostgreSQL (shadow—possibly for other KG), Grafeo (Self KG, Other KGs).

A single "decision cycle" may involve writes to multiple databases:

```
1. Decision Making reads from WKG (Neo4j) and Self KG (Grafeo)
2. Decision Making records prediction to TimescaleDB
3. Decision Making executes action
4. Action outcome recorded to TimescaleDB
5. Drive Engine reads outcome from TimescaleDB and updates internal state
6. Drive Engine emits new drive snapshot via IPC
7. Learning consolidates events from TimescaleDB
8. Learning writes new edges to WKG (Neo4j)
9. Learning may trigger self-evaluation
10. Self-evaluation reads Self KG, writes update
```

If a crash occurs between steps 2 and 4, the prediction is recorded but the outcome is not. The event stream is incoherent.

### Mitigation Strategies

**Strategy 1: Idempotency**
Every operation should be idempotent: re-running it produces the same result as running it once. This is standard for distributed systems.

**E1 implication:** Event emission must include a globally unique correlation ID. If an event is emitted twice (due to retry), it should be deduplicated. TimescaleDB schema should include `event_id UUID NOT NULL` as primary key or unique constraint.

**Strategy 2: Eventual Consistency**
Do not require strong consistency across databases. Accept that Self KG may lag behind WKG by a few seconds. Accept that Planning may read stale TimescaleDB state. Design the system to tolerate this.

**E1 implication:** Schema should include timestamp fields on all writes. Readers should check freshness and accept stale data within a time window. For self-critical operations (e.g., drive evaluation), require freshness checks.

**Strategy 3: Two-Phase Commit?**
No. Distributed transactions are expensive and fragile. Sylphie should not use them.

**Better:** Use event sourcing. All state is derived from events. Events are written to TimescaleDB (single source of truth), then other databases are updated asynchronously by reading events.

This is already partially the design: Decision Making → Action → Event to TimescaleDB → Drive Engine/Learning/Planning read from TimescaleDB.

**E1 implication:** Ensure TimescaleDB is the authoritative source of events. Every subsystem writes decisions and outcomes as events. Other databases (WKG, Self KG, Drive Rules) are derived state. If a database is corrupted, it can be rebuilt from TimescaleDB events (disaster recovery).

---

## 9. Load and Scaling Implications

### Event Volume

5 subsystems writing to TimescaleDB at 100Hz per subsystem = 500 events per second in steady state. Over 1 hour, that's 1.8 million events.

TimescaleDB can handle this easily on a single node. But the schema must be efficient:

**E1 requirement:** TimescaleDB schema should:
- Use hypertables with 1-day intervals
- Enable compression on events older than 7 days
- Implement columnar encoding for frequent aggregate queries
- Index on (subsystem_source, event_type, timestamp) for fast filtering

### WKG Growth

Learning adds edges at steady rate. Suppose: 10-20 new edges per maintenance cycle, cycles every 30 seconds → ~2 edges/sec → ~7k edges/hour.

After 1 year of 24/7 operation: ~60M edges. Neo4j can handle this easily.

**E1 requirement:** Neo4j schema should:
- Index on provenance source (fast "what's GUARDIAN knowledge?")
- Index on confidence value (fast "what's above 0.50 threshold?")
- Use Neo4j community constraints to enforce uniqueness where needed

### IPC Overhead

Drive Engine child process communicates via JSON-serialized messages. At 100Hz, latency should be < 5ms per IPC round-trip (typical for Node.js fork).

**E1 requirement:** No special database optimization needed for IPC; this is OS-level. But measure and log IPC latency in E4 (Drive Engine) for performance monitoring.

---

## 10. Summary of E1 Requirements from Cybernetic Analysis

### Tier 1 (Critical)

1. **Drive rule write protection:** PostgreSQL RLS enforces that `sylphie_app` role cannot UPDATE/DELETE `drive_rules`. Guardian approval required.
2. **Event stream coherence:** TimescaleDB hypertable with unique event_id (UUID) to prevent duplicates. Idempotent semantics.
3. **Provenance enforcement:** Neo4j schema constraint that every node/edge requires provenance field. No unprovenance edges can be created.
4. **Confidence ceiling enforcement:** Upsert operations in WKG must clamp confidence to 0.60 for untested nodes (CANON Standard 3).

### Tier 2 (Important)

5. **Isolation validation:** Grafeo availability check; contingency plan (SQLite + translator) if unavailable.
6. **Two-pool PostgreSQL:** Admin pool (offline credentials) for rule approval. App pool (runtime) for read-only `drive_rules`, insert-only `proposed_drive_rules`.
7. **Event retention policy:** Time-based retention (30 days), not space-based. Ensures Learning has access to historical events before they're archived.
8. **Cypher support uniformity:** All three KGs (WKG, Self KG, Other KG) should support equivalent Cypher queries (or translation layer if technology differs).

### Tier 3 (Nice-to-Have)

9. **Performance indexing:** Neo4j indexes on provenance/confidence for fast retrieval. TimescaleDB aggregation indexes for frequency queries.
10. **Audit logging:** All rule proposals, approvals, deprecations logged to separate audit table.
11. **Disaster recovery:** Document procedure to rebuild WKG from TimescaleDB events (though not needed for Phase 1).

---

## 11. System-Theoretic Verdict

**Structural Assessment:** The five-database topology is **sound**. It correctly separates concerns (semantic vs. episodic, autonomous vs. supervised, decentralized vs. centralized) and implements multiple tiers of defense against self-modification.

**Coherence Assessment:** Isolated knowledge graphs create an indirect coupling (WKG → Self KG via Learning updates) that requires explicit specification. The proposed mechanism (Learning triggers self-evaluation after consolidation) is adequate but depends on correct implementation in E3-E4.

**Cold-Start Assessment:** System can initialize successfully IF early Type 2 dominance carries explicit cost AND cold-start dampening prevents opportunity inflation. These are implementation concerns (E4-E5), not database concerns.

**Failure Mode Assessment:** Database design prevents or mitigates 3 of 6 attractor states (Rule Drift, Hallucinated Knowledge via confidence ceiling, partial help on Depressive Attractor via audit). Other three depend on algorithmic prevention (E4-E5).

**Recommendation:** Proceed with E1 as scoped. Implement Tier 1 requirements fully. Validate Grafeo in parallel (Tier 2). Budget E3-E4 implementation time for coherence validation.

---

## References

**Primary sources:**
- Ashby, W.R. (1956). *An Introduction to Cybernetics.* Chapman & Hall.
- Campbell, D.T. (1976). "Assessing the impact of planned social change." In *The Public Science of Public Policy.*
- CANON.md (project document)
- Phase 1 Roadmap (project document)

**Systems theory foundations:**
- Wiener, N. (1948). *Cybernetics: Control and Communication in the Animal and the Machine.*
- Powers, R.T. (1973). *Behavior: The Control of Perception.*

---

**Analysis completed:** 2026-03-29
**For:** Epic 1 planning validation
**Authority:** Ashby, Systems & Cybernetics Theorist
