# Epic 1 Decisions

## Decisions Made During Planning

### D1: Provenance enforcement at database level
**Decision:** Neo4j constraints enforce provenance NOT NULL on all node labels, not just service-layer validation.
**Reason:** Canon analysis flagged that service-layer-only enforcement leaves a gap — direct Cypher queries, migration scripts, or bugs could create nodes without provenance. CANON §7 states "This distinction is never erased." Database-level constraints make violation structurally impossible.
**Source:** Canon agent analysis (§2 Provenance), Atlas agent analysis (§2 Constraints)

### D2: SQLite + graph abstraction as Grafeo fallback
**Decision:** If Grafeo fails validation, use SQLite with vertex/edge tables and a custom traversal layer (one .sqlite file per KG instance).
**Reason:** Atlas recommended TinkerPop/neo4j-js; Sentinel recommended SQLite. SQLite wins on pragmatic grounds: zero JVM dependency, built-in persistence, proven durability, per-file isolation matches per-person KG requirement perfectly. The trade-off is no native Cypher — but Self KG and Other KG queries are simple enough that a custom query layer is sufficient.
**Source:** Atlas agent analysis (§1.3 Fallback Options), Sentinel agent analysis (§4 Grafeo Risk)

### D3: DatabaseModule owns PostgreSQL pools
**Decision:** Create a new DatabaseModule that owns both PostgreSQL pools (admin + runtime). Admin pool stays internal. Runtime pool is exported.
**Reason:** Forge analysis identified that PostgreSQL pools don't naturally belong to any single subsystem module. A dedicated DatabaseModule provides clean ownership. Not exporting the admin pool means any subsystem that accidentally tries to inject it gets a NestJS DI error.
**Source:** Forge agent analysis (§3 New modules needed), building on E0 Decision D5

### D4: TimescaleDB retention at 90 days
**Decision:** 90-day retention policy, 7-day compression policy.
**Reason:** Ashby flagged that retention must exceed maximum Learning consolidation lag. Learning runs on pressure-driven timescale via Cognitive Awareness drive (not calendar time). 90 days provides ample buffer for consolidation to process events before they're eligible for deletion. Compression at 7 days reduces storage without losing queryability.
**Source:** Ashby agent analysis (§3 Compression/Retention interaction with Learning), Sentinel agent analysis (§1.2 TimescaleDB)

### D5: Grafeo validation as blocking gate (E1-T001)
**Decision:** First ticket in E1 is technology validation. No KG implementation work starts until Grafeo is validated or fallback is selected.
**Reason:** Atlas, Sentinel, and Canon all flagged Grafeo as a critical risk. Running validation first (1-2 hours) prevents building on an unproven foundation. The E0 interface-first design means the rest of the codebase is not affected by this decision.
**Source:** Atlas agent analysis (§1 CRITICAL BLOCKER), Sentinel agent analysis (§4), Canon analysis (§3 Grafeo availability risk)
**Status:** VALIDATED (2026-03-29) — Grafeo passes all 5 criteria. See D5.1 below.

### D6: Neo4j three-level schema seeds on init
**Decision:** OnModuleInit creates MetaSchema root node and Schema root node as bootstrap seeds. These use SYSTEM_BOOTSTRAP provenance.
**Reason:** The three-level schema system (instance, schema, meta-schema) requires structural anchors. Seeding on init is not pre-populating knowledge — it's creating the organizational structure that knowledge will grow into.
**Source:** Atlas agent analysis (§2.1 Three-Level Schema System)

### D7: Self KG minimal seed on init
**Decision:** Self KG starts with a single root node "Self" with SYSTEM_BOOTSTRAP provenance and default ACT-R parameters.
**Reason:** Ashby flagged cold-start dynamics — an empty Self KG means self-evaluation has nothing to read, which could lead to depressive attractor state. A minimal seed provides a foundation for self-evaluation to build on without violating the experience-first principle.
**Source:** Ashby agent analysis (§5 Cold Start Dynamics), Atlas agent analysis (§Self KG initialization)

### D8: Drive rules table includes provenance and audit columns
**Decision:** drive_rules table carries provenance (who created the rule), created_by, and audit columns. proposed_drive_rules carries full workflow columns (proposed_by, status, reviewed_by, reviewed_at, review_notes).
**Reason:** CANON Standard 6 requires guardian-only rule approval. The audit trail enables verification that no rules were autonomously activated. The proposed_drive_rules workflow columns support the guardian review queue.
**Source:** Sentinel agent analysis (§1.3 PostgreSQL), Canon analysis (§1 Drive Isolation)

### D5.1: Grafeo validation results (E1-T001)
**Decision:** Grafeo passes all five validation criteria. Proceed with Grafeo for Self KG and Other KG implementation.
**Date Validated:** 2026-03-29
**Validation Script:** test-grafeo-validation.ts (comprehensive 5-criterion test + PoC with isolation verification)

**Criteria Passed:**
1. **Installation without peer dependency conflicts** ✓
   - @grafeo-db/js v0.5.28 installed successfully into NestJS project
   - Zero peer dependencies; no version conflicts

2. **Cypher/GQL query support** ✓
   - Supports executeCypher() with full MATCH/RETURN/WHERE semantics
   - Also supports executeSql(), executeGremlin(), executeGraphql(), executeSparql()
   - Tested: Multi-node traversals, filters, aggregations

3. **Completely isolated instances** ✓
   - Created 3 independent in-memory database instances
   - Each instance has independent nodeCount() and edge sets
   - Data in instance A not visible in instances B and C (verified by cross-instance query)
   - Both in-memory and file-based isolation confirmed

4. **Persistent storage (not in-memory only)** ✓
   - GrafeoDB.create(path) creates file-backed databases
   - GrafeoDB.open(path) reopens existing databases
   - Data survives close/reopen cycle; nodeCount matches after reopen
   - Tested with separate .grafeo files; no data loss

5. **Performance for small graphs** ✓
   - 100 node inserts: 0-1ms
   - 10 traversal queries: 2-3ms
   - Total: 3ms (target: <500ms)
   - Performance is EXCELLENT; far exceeds requirements

**Proof of Concept (PoC):**
- KG(Self) instance: SelfConcept -> HAS_CAPABILITY -> Capability graph structure
- KG(Other_jim) instance: PersonModel -> HAS_PREFERENCE -> Preference graph structure
- Cross-checked isolation: KG(Self) contains zero PersonModel nodes; KG(Other_jim) contains zero SelfConcept nodes
- Cypher queries execute correctly across both instance types

**Implications:**
- Self KG Service will use GrafeoDB.create() for singleton instance initialized in KnowledgeModule.onModuleInit
- Other KG Service will use GrafeoDB.create(personPath) for per-person instances
- No SQLite fallback needed; Grafeo is production-ready for our use case
- Cypher (via executeCypher) is the primary query language; sufficient for Learning and Decision Making subsystems
- Can safely implement ISelfKgService and IOtherKgService using Grafeo backend

**Next Steps:**
- Remove test-grafeo-validation.ts from repository after decision is documented (artifact of validation, not part of codebase)
- Create src/knowledge/graph-store/ abstraction layer (optional but recommended for implementation safety)
- Begin ISelfKgService and IOtherKgService implementation with Grafeo backend

---

## Decisions Requiring Jim

### P1: Neo4j provenance as database constraint vs. application-only
**Proposed:** Database-level constraint (NOT NULL on provenance property for all node labels).
**Trade-off:** Database constraints are stronger but Neo4j Community Edition may not support property existence constraints on all label types. If not supported, fall back to application-layer enforcement with startup verification test.
**Recommendation:** Apply constraints where supported, test at startup, document any gaps.
**Status:** APPROVED (2026-03-29) — Apply constraints where supported, application-layer enforcement with startup verification as fallback

### P2: Grafeo technology — proceed with validation gate approach?
**Proposed:** E1-T001 validates Grafeo first (1-2 hours). If fails, switch to SQLite + graph abstraction.
**Trade-off:** SQLite loses native Cypher support but gains simplicity and reliability.
**Recommendation:** Proceed with validation gate. SQLite fallback is well-understood and sufficient for Self/Other KG use cases.
**Status:** APPROVED (2026-03-29) — Proceed with validation gate, SQLite fallback if needed

### P3: TimescaleDB retention period (90 days)
**Proposed:** 90-day retention with 7-day compression.
**Trade-off:** Longer retention i