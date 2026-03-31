# Epic 1: Database Infrastructure — Canon Compliance Analysis

**Reviewed against:** `wiki/CANON.md` (immutable single source of truth)
**Date:** 2026-03-29
**Analyst:** Canon (Project Integrity Guardian)

---

## Executive Summary

Epic 1 defines the database infrastructure for all five subsystems. The specification addresses the CANON's architectural boundaries but exposes **three critical gaps** and **one architectural decision requiring explicit Jim approval**.

**Compliance Status:** 7 of 9 checks COMPLIANT. 2 gaps identified.

---

## 1. Drive Isolation (CANON §Drive Isolation + Immutable Standard 6)

### Specification
PostgreSQL RLS design:
- `sylphie_app` role: SELECT on `drive_rules`, INSERT on `proposed_drive_rules` only
- Two-pool approach (guardian-only write pool vs. read-only app pool)

### CANON References
- **§Drive Isolation:** "Drive computation logic runs in a **separate process** with a one-way communication channel. The system can READ drive values but cannot WRITE to the evaluation function. Drive rules in Postgres are write-protected from autonomous modification."
- **§Immutable Standard 6:** "Sylphie can learn WHAT to do, HOW effective each action is, and WHEN to do it. She cannot learn to modify HOW success is measured — the evaluation function is fixed architecture."

### Analysis

**COMPLIANT** — The PostgreSQL RLS design correctly enforces the architectural boundary:

- ✓ The `sylphie_app` role can SELECT from `drive_rules` (read access for rule lookup in E4 Drive Engine)
- ✓ The `sylphie_app` role can INSERT into `proposed_drive_rules` only (E4 can propose, but cannot approve/activate)
- ✓ No UPDATE/DELETE/ALTER on `drive_rules` for the app role
- ✓ The guardian's role (implied: `postgres` or `drive_admin`) holds exclusive write permission to `drive_rules`
- ✓ Two-pool separation is sufficient: guardian pool for writes, app pool for reads

**Strength:** The RLS approach is database-enforced, not application-enforced — the boundary is structural, not just coded.

**Minor clarification needed:** E1 should specify which role the Drive Engine subprocess uses to query PostgreSQL. If it runs as `sylphie_app`, it can read rules. If the Drive Engine needs to query the evaluation function directly, that's acceptable. But ensure subprocess isolation is documented.

**Implication for E4:** When Drive Engine (subprocess) reads `drive_rules`, it does so with SELECT-only credentials. When the app proposes a new rule, it INSERTs into `proposed_drive_rules` and the guardian reviews there — not in production `drive_rules`.

---

## 2. Provenance (CANON §Core Philosophy 7 + Immutable Standard 3)

### Specification
Neo4j schema enforces provenance on every node and edge. Every write requires a provenance tag.

### CANON References
- **§Core Philosophy 7:** "Every node and edge in the WKG carries a provenance tag: SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE. This distinction is never erased."
- **§Immutable Standard 3 (Confidence Ceiling):** "No knowledge exceeds 0.60 confidence without at least one successful retrieval-and-use event. Knowing something isn't enough — you have to use it and succeed."

### Analysis

**COMPLIANT** — E1 specifies that provenance is enforced as a required field on every graph write:

- ✓ E1 states: "Provenance required on every write (enforced at service layer)"
- ✓ E3 (Knowledge module) implements full enforcement: "upsertNode, findNode, upsertEdge, queryEdges with provenance enforcement"
- ✓ The four provenance sources are defined in E0 shared types: SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE

**Structurally Impossible to Create Without Provenance?** — **PARTIAL**

E1 does NOT specify whether the Neo4j schema enforces provenance at the **database level** (UNIQUE constraint, NOT NULL, enum check). The CANON states: "This distinction is never erased. It enables the lesion test."

**Current specification:** Provenance enforced at the "service layer" (application code) — this is **not a structural guarantee**. If the service layer is bypassed (e.g., direct Cypher query, data migration script, bug), a node can be created without provenance.

**Recommendation:** E1 should include Neo4j constraint:
```cypher
CREATE CONSTRAINT provenance_on_nodes FOR (n) REQUIRE n.provenance IS NOT NULL
CREATE CONSTRAINT provenance_on_edges FOR ()-[r]-() REQUIRE r.provenance IS NOT NULL
```

This makes it **structurally impossible** to violate. Aligns with CANON intent.

**Decision required for Jim:** Is service-layer enforcement sufficient, or should provenance be a database-level constraint?

---

## 3. KG Isolation (CANON §Architecture)

### Specification
Three graph stores completely isolated:
1. **World Knowledge Graph (WKG)** — Neo4j
2. **Self Knowledge Graph (KG(Self))** — Grafeo
3. **Other Knowledge Graphs (KG(Other_X))** — Grafeo (per-person instances)

No shared edges, no cross-contamination.

### CANON References
- **§Shared Infrastructure:** "World Knowledge Graph (Neo4j) — The Brain. Structured knowledge. What Sylphie knows about the world, herself, procedures, and relationships."
- **Architectural separation principle:** "Self KG and Other KG are completely isolated from each other and from the WKG."

### Analysis

**COMPLIANT** — E1 architecture ensures complete isolation:

- ✓ **WKG (Neo4j):** Separate database instance, contains world knowledge
- ✓ **Self KG (Grafeo):** Separate embedded instance, isolated from WKG
- ✓ **Other KG (Grafeo, per-person):** Map keyed by personId, each person gets an isolated Grafeo instance
- ✓ No queries cross databases
- ✓ Episodic Memory (TimescaleDB) is separate from all three KGs — temporal events, not knowledge

**Cross-contamination risk:** Low. The specification explicitly states separate service instances for each KG type, with no foreign key or edge references between them.

**Grafeo availability risk:** E1 flags this: "Key risk: Grafeo availability. If Grafeo doesn't exist as a mature library, evaluate alternatives." This is a valid risk but not a compliance violation — it's acknowledged as a **technology validation gate** before implementation.

---

## 4. Five Databases Match CANON

### Specification
E1 requires all five database technologies specified in CANON:
1. Neo4j (WKG)
2. TimescaleDB (event backbone)
3. PostgreSQL (drive rules, settings, users)
4. Grafeo (Self KG)
5. Grafeo (Other KG instances)

### CANON References
- **§Shared Infrastructure:** Explicit list of databases with roles
- **CLAUDE.md §Five Databases:** Complete mapping

### Analysis

**COMPLIANT** — E1 deliverables list matches CANON exactly:

| Database | CANON Role | E1 Deliverable | Status |
|----------|-----------|-----------------|--------|
| Neo4j | WKG | "Neo4j driver factory provider, constraint setup on module init, health check" | ✓ |
| TimescaleDB | Event backbone | "TimescaleDB connection (pg client), hypertable schema, compression/retention policies" | ✓ |
| PostgreSQL | Drive rules + meta | "`drive_rules` table (write-protected), `proposed_drive_rules`, `users`, `settings`" | ✓ |
| Grafeo | Self KG | "Grafeo integration for Self KG" | ✓ |
| Grafeo | Other KG | "Grafeo integration for... Other KG" | ✓ |

**No deviations.** All five databases accounted for.

---

## 5. TimescaleDB as Event Backbone (CANON §Shared Infrastructure)

### Specification
E1 sets up TimescaleDB hypertables, compression, and retention policies to serve all five subsystems.

### CANON References
- **§Shared Infrastructure / TimescaleDB:** "Every subsystem writes to TimescaleDB. It is the system's episodic record — what happened, when, in what context, with what drive state."
- **All five subsystems read from it:** Decision Making, Communication, Learning, Drive Engine, Planning
- **§Subsystem 3 (Learning):** "Query TimescaleDB for response events with `has_learnable=true` (max 5 per cycle)"
- **§Subsystem 4 (Drive Engine):** "Tick Event → query last 10 event frequencies from TimescaleDB"
- **§Subsystem 5 (Planning):** "Research Opportunity → query event frequency from TimescaleDB"

### Analysis

**COMPLIANT** — E1 specifies the right infrastructure:

- ✓ "TimescaleDB connection (pg client), **hypertable schema**, compression/retention policies"
- ✓ Hypertables are TimescaleDB's native time-series structure
- ✓ Compression and retention policies are TimescaleDB features for managing high-volume event data
- ✓ E2 (Events Module) will implement IEventService with methods: record(), query(), queryLearnableEvents(), queryEventFrequency(), markProcessed()

**Specification Gap — Stream Separation:** E1 does NOT explicitly define how events are typed or partitioned. CANON states: "Stream separation: Events should be logically typed (prediction events, communication events, drive events, learning events) to reduce coupling between subsystems."

E2 will handle this, but E1 should clarify the hypertable strategy:
- Single `events` hypertable with `event_type` discriminant column?
- Or multiple hypertables (one per subsystem)?

Recommend clarification in E1 Docker Compose / schema section.

---

## 6. Phase Boundaries (No Phase 2 Concerns)

### Specification
E1 stays within Phase 1 scope.

### CANON References
- **§Implementation Phases / Phase 1:** "Build all five subsystems: Decision Making, Communication, Learning, Drive Engine, and Planning."
- **§Phase 2:** "Connect to physical robot chassis. Perception layer processes real sensor data."

### Analysis

**COMPLIANT** — E1 makes no references to:
- Robot hardware
- Sensor APIs
- Motor control
- Camera/LIDAR perception
- Physical exploration procedures

All E1 work is software infrastructure. Phase 2 hardware interfaces (CANON A.11) are explicitly out of scope.

---

## 7. Confidence Dynamics (ACT-R Schema Support)

### Specification
Schema supports confidence computation on every node and edge:
- base (SENSOR: 0.40, GUARDIAN: 0.60, LLM_GENERATED: 0.35, INFERENCE: 0.30)
- count (retrieval successes)
- decay rate (per-type, tunable)
- lastRetrievalAt (timestamp for hour decay calculation)

### CANON References
- **§Confidence Dynamics:** "`min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))`"
- **§Immutable Standard 3:** "No node exceeds 0.60 confidence without at least one successful retrieval-and-use event"

### Analysis

**PARTIAL COMPLIANCE** — E1 does NOT explicitly specify Neo4j node/edge attributes for confidence computation.

E1 states that E3 (Knowledge Module) will implement "Real `ConfidenceService`: ACT-R confidence wrapping pure functions + retrieval tracking."

But E1 should define the schema:

**Recommended E1 additions:**
```
Neo4j node/edge properties:
  - provenance: ENUM(SENSOR | GUARDIAN | LLM_GENERATED | INFERENCE)
  - confidence: FLOAT [0.0, 1.0]
  - confidenceBase: FLOAT (initial value per provenance source)
  - retrievalCount: INT (>=0, counts successful uses)
  - lastRetrievalAt: DATETIME (ISO 8601, UTC)
  - createdAt: DATETIME
  - decayRate: FLOAT (per-provenance-source default, overridable)
```

Without explicit schema definition, E3 must infer it. **This is not a blocker** (E3 is responsible for knowledge service implementation), but it's a specification gap in E1.

**Decision for Jim:** Should E1 define the full Neo4j schema, or defer all knowledge-layer details to E3?

---

## 8. Guardian Asymmetry (2x Confirmation, 3x Correction Weight)

### Specification
E1 does not directly specify this — it's a Drive Engine (E4) concern. But the database layer (PostgreSQL) must support it.

### CANON References
- **§Core Philosophy 4:** "Guardian confirmation weight: **2x** equivalent algorithmic events. Guardian correction weight: **3x** equivalent algorithmic events."
- **§Immutable Standard 5:** "Guardian feedback always outweighs algorithmic evaluation. Confirmations = 2x weight. Corrections = 3x weight."

### Analysis

**IMPLICITLY COMPLIANT** — E1 does not block guardian asymmetry:

- ✓ PostgreSQL stores `drive_rules` with the ability to weight different event sources
- ✓ E4 (Drive Engine) will implement the 2x/3x logic when evaluating rules
- ✓ E2 (Events Module) will tag events with their source (algorithmic vs. guardian)

**Schema requirement (E1 should clarify):** When Drive Engine queries `drive_rules`, does each rule carry:
- A weight multiplier for confirmations vs. corrections?
- Or is the 2x/3x applied at the Drive Engine layer during evaluation?

Recommend E1 clarify whether rule rows include `confirmation_weight` and `correction_weight` columns, or if this is hardcoded (2.0x, 3.0x).

---

## 9. Planning Rules (Pre-Implementation Planning)

### Specification
E1 is a database infrastructure epic. Is it properly planned before implementation?

### CANON References
- **§Planning & Implementation Rules:** "No code without epic-level planning validated against this CANON. Every epic is planned by parallel agents who cross-examine each other."

### Analysis

**COMPLIANT** — E1 is well-specified in the Phase 1 roadmap:

- ✓ Complexity: L (Low)
- ✓ Dependencies clearly mapped: E0 (must complete first)
- ✓ Deliverables explicitly listed (9 items)
- ✓ Known risks flagged (Grafeo availability)
- ✓ v1 code sources identified for lift
- ✓ Docker Compose integration specified

E1 is **blocking for E2, E3, E4** (all depend on database infrastructure). This is the correct critical path position.

**Readiness for implementation:** E1 can proceed immediately after E0 completion.

---

## Critical Gaps & Decisions for Jim

### Gap 1: Provenance as Database Constraint vs. Application Enforcement

**What:** E1 specifies provenance enforcement "at service layer" but not as a database constraint.

**Why it matters:** CANON §Core Philosophy 7 states "This distinction is never erased. It enables the lesion test." A database-level constraint makes this structurally enforced. Application-layer enforcement can be bypassed by direct queries or bugs.

**Recommendation:** Before E1 implementation, add Neo4j constraints:
```cypher
CREATE CONSTRAINT provenance_on_nodes FOR (n) REQUIRE n.provenance IS NOT NULL
CREATE CONSTRAINT provenance_on_edges FOR ()-[r]-() REQUIRE r.provenance IS NOT NULL
```

**Decision required:** Shall E1 include these Neo4j constraints, or is service-layer enforcement sufficient?

---

### Gap 2: Neo4j Confidence Schema Not Fully Specified

**What:** E1 does not define which Neo4j node/edge properties store confidence data (base, count, decayRate, lastRetrievalAt).

**Why it matters:** E3 (Knowledge Module) must implement the ACT-R formula. Schema clarity prevents rework.

**Recommendation:** E1 should define a standard property set on all nodes/edges:
- `provenance` (required, enum)
- `confidence` (float, computed on read)
- `confidenceBase` (float, per-provenance-source)
- `retrievalCount` (int, default 0)
- `lastRetrievalAt` (datetime, nullable)
- `createdAt` (datetime)

**Decision required:** Should E1 specify this schema fully, or does E3 define it during Knowledge Module implementation?

---

### Gap 3: TimescaleDB Event Stream Separation Not Specified

**What:** E1 says "hypertable schema" but does not clarify whether events are:
- One table with a type discriminant column, OR
- Multiple tables (one per subsystem type)

**Why it matters:** CANON states "Stream separation: Events should be logically typed (prediction events, communication events, drive events, learning events) to reduce coupling between subsystems."

**Recommendation:** E1 should clarify the strategy:
- **Option A:** Single `events` hypertable with `event_type` ENUM column, indexed
- **Option B:** Multiple hypertables partitioned by subsystem (events_decision_making, events_communication, etc.)
- **Option C:** Single hypertable with multiple logical partitions via tags

**Decision required:** Which event partitioning strategy should E1 enforce in Docker Compose?

---

### Gap 4: PostgreSQL Schema for Drive Rules Not Fully Defined

**What:** E1 states `drive_rules` table must be write-protected but does not specify columns.

**Why it matters:** The Drive Engine (E4) queries this table. Missing schema clarity blocks E4 planning.

**Recommendation:** E1 should define (at minimum):
```sql
CREATE TABLE drive_rules (
  id UUID PRIMARY KEY,
  rule_name VARCHAR NOT NULL,
  event_source VARCHAR NOT NULL,  -- SENSOR | GUARDIAN | PREDICTION_OUTCOME | ...
  event_type VARCHAR NOT NULL,
  affected_drives JSONB,  -- map: drive_name -> delta
  confirmation_weight FLOAT DEFAULT 1.0,
  correction_weight FLOAT DEFAULT 1.0,
  created_at TIMESTAMP DEFAULT now(),
  created_by VARCHAR,
  guardian_approved BOOLEAN DEFAULT false,

  UNIQUE(event_source, event_type)  -- prevent duplicate rules
);

CREATE TABLE proposed_drive_rules (
  id UUID PRIMARY KEY,
  rule_data JSONB,  -- matches drive_rules structure
  proposed_by VARCHAR,
  proposed_at TIMESTAMP DEFAULT now(),
  guardian_review_status VARCHAR  -- PENDING | APPROVED | REJECTED
);
```

**Decision required:** Should E1 define the PostgreSQL schema in this detail, or can E4 propose the schema during Drive Engine planning?

---

## Recommendations for Implementation

### Before E1 Implementation Begins

1. **Obtain Jim approval** on the four gaps listed above (provenance constraints, Neo4j confidence schema, event stream strategy, PostgreSQL drive_rules schema).

2. **Validate Grafeo availability.** E1 explicitly flags this risk. Recommend:
   - Check Grafeo GitHub (https://github.com/grafeo/grafeo) for maturity, last commit date, open issues
   - If immature, evaluate alternatives (Memgraph for embedded LPG with Cypher, or SQLite + graph abstraction layer)
   - Document decision before Docker Compose is finalized

3. **Finalize Docker Compose strategy.** E1 should include:
   - All five services (Neo4j, TimescaleDB, PostgreSQL, Grafeo setup)
   - Health checks for each
   - Volume mounts for persistence
   - Network configuration for subprocess communication (E4 will need IPC with Drive Engine child process)

### During E1 Implementation

1. **Add database-level constraints** for provenance (if Jim approves).

2. **Schema design for Neo4j, TimescaleDB, PostgreSQL** should be reviewed for:
   - Full consistency with CANON confidence dynamics
   - Support for all five subsystems' query patterns (E2, E3, E4, E5, E6, E7, E8 use cases)

3. **RLS validation** on PostgreSQL:
   - Create two roles: `sylphie_app` (SELECT drive_rules, INSERT proposed_drive_rules) and guardian role
   - Test that `sylphie_app` cannot UPDATE/DELETE drive_rules
   - Test that the Drive Engine subprocess can query drive_rules with `sylphie_app` credentials

4. **Document all schema decisions** in `docs/architecture/database-schema.md` for reference by E2, E3, E4 teams.

### After E1 Completion

1. **E2 (Events Module)** consumes the TimescaleDB schema
2. **E3 (Knowledge Module)** consumes the Neo4j and Grafeo setup
3. **E4 (Drive Engine)** consumes the PostgreSQL drive_rules and the separate process isolation architecture

---

## Conclusion

**Epic 1 is architecturally sound and well-specified for a database infrastructure epic.** It correctly translates CANON principles into concrete deliverables and identifies the critical risk (Grafeo availability).

**Compliance Summary:**
- ✓ Drive Isolation: COMPLIANT
- ✓ Provenance: COMPLIANT (service-layer) — consider database constraints
- ✓ KG Isolation: COMPLIANT
- ✓ Five Databases: COMPLIANT
- ✓ TimescaleDB Event Backbone: COMPLIANT — clarify stream separation strategy
- ✓ Phase Boundaries: COMPLIANT
- ✓ Confidence Dynamics: PARTIAL (schema not fully specified)
- ✓ Guardian Asymmetry: IMPLICITLY COMPLIANT
- ✓ Planning Rules: COMPLIANT

**Outstanding decisions requiring Jim:**
1. Provenance as database constraint or service-layer only?
2. Full Neo4j schema definition in E1 or deferred to E3?
3. TimescaleDB event partitioning strategy (single vs. multiple tables)?
4. PostgreSQL drive_rules schema detail level for E1 vs. E4?

These are **not blockers** — they are clarifications that improve downstream epics' planning. E1 can proceed pending Jim's guidance.
