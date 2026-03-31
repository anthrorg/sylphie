# Epic 1: Database Infrastructure

## Summary

Wire all 5 database connections, create schemas, and replace E0 stubs with real connection providers. This epic builds the persistence layer that Sylphie's five subsystems depend on. After E1, every database is reachable, schemas are applied, RLS is enforced, and health checks validate the infrastructure on every startup.

## Why This Epic Matters

The databases are not storage — they ARE the feedback loops. Neo4j is Sylphie's brain. TimescaleDB is her episodic memory. PostgreSQL holds the fixed evaluation rules that prevent reward hacking. Self KG and Other KG are her self-awareness and empathy. Getting this infrastructure right enables every subsequent epic to focus on behavior rather than plumbing.

## Ticket Summary (9 tickets)

| ID | Title | Complexity | Dependencies |
|----|-------|-----------|-------------|
| E1-T001 | Grafeo validation + technology decision | M | - |
| E1-T002 | Docker Compose finalization | S | - |
| E1-T003 | Neo4j driver factory + constraints + health | M | T002 |
| E1-T004 | PostgreSQL DDL + RLS + two-pool provider | L | T002 |
| E1-T005 | TimescaleDB connection + hypertable + policies | M | T002 |
| E1-T006 | Self KG provider with isolation | M | T001 |
| E1-T007 | Other KG provider with per-person instances | M | T001 |
| E1-T008 | Health check module + startup verification | M | T003-T007 |
| E1-T009 | Integration testing + full verification | M | T008 |

## Parallelization

```
T001 (Grafeo validation)    T002 (Docker Compose)
  |                           |
  |                     +-----+-----+
  |                     |     |     |
  |                     v     v     v
  |                   T003  T004  T005  (Neo4j, Postgres, TimescaleDB -- parallel)
  |                     |     |     |
  +-------+-------+    |     |     |
  |       |       |    |     |     |
  v       v       |    |     |     |
T006    T007      |    |     |     |
  |       |       |    |     |     |
  +-------+---+---+----+-----+-----+
              |
              v
            T008 (Health checks -- needs all DBs)
              |
              v
            T009 (Integration tests)
```

## Key Design Decisions

1. **Provenance at database level.** Neo4j constraints enforce NOT NULL on provenance for all node labels. Service-layer validation is belt-and-suspenders. Makes CANON §7 violation structurally impossible.

2. **Grafeo validation as blocking gate.** E1-T001 runs first. If Grafeo fails, SQLite + graph abstraction replaces it. The E0 interface-first design insulates the rest of the codebase from this decision.

3. **DatabaseModule owns PostgreSQL pools.** New module that owns admin + runtime pools. Admin pool is internal-only (not exported). Runtime pool is exported with RLS-enforced permissions.

4. **TimescaleDB 90-day retention.** Exceeds maximum expected Learning consolidation lag. Compression at 7 days for storage efficiency. Ashby analysis confirms this prevents Learning/retention interaction problems.

5. **Three-layer drive isolation in E1.** Database layer (RLS on drive_rules), application layer (admin pool not exported), and interface layer (IDriveStateReader read-only). Process layer added in E4.

6. **Self KG minimal seed.** One "Self" root node with SYSTEM_BOOTSTRAP provenance prevents cold-start depressive attractor while respecting experience-first principle.

7. **Neo4j three-level schema seeds.** MetaSchema and Schema root nodes created on init. These are structural anchors, not pre-populated knowledge.

8. **Drive rules table with full audit trail.** Provenance, created_by, and workflow columns on proposed_drive_rules support guardian review queue per CANON Standard 6.

## Agent Analyses

See `agent-analyses/` for full perspectives from:
- **Sentinel**: Complete DDL, Docker config, connection pooling, migration strategy, 10-ticket breakdown
- **Forge**: Module wiring, factory providers, DI patterns, health checks, error handling, 9-ticket breakdown
- **Atlas**: Neo4j schema design, Grafeo validation criteria, KG isolation enforcement, provenance architecture, 8 risks
- **Canon**: 7/9 CANON checks compliant, 2 gaps (provenance enforcement level, confidence schema detail), 4 decisions for Jim
- **Ashby**: Database topology as feedback infrastructure, drive isolation variety analysis, 3 structural leak paths (E3-E4), cold-start dynamics, retention/Learning interaction

## Decisions Requiring Jim

1. **Provenance enforcement:** Database constraint vs. application-only? (Recommended: database where supported)
2. **Grafeo approach:** Proceed with validation gate + SQLite fallback? (Recommended: yes)
3. **TimescaleDB retention:** 90 days acceptable? (Recommended: yes, revisit after observing patterns)

## Ashby's Structural Leak Warnings (for E3-E4)

Three structural leaks in the drive isolation boundary that E1 cannot fully address:
1. **Opportunity inflation**: Drive Engine can be fooled by fabricated prediction failures → mitigate in E4
2. **Contingency gaming**: Information gain metric is self-measured → mitigate in E3 (Learning) by pegging to observable WKG changes
3. **Confidence forgery**: If Confidence Service has side effects → mitigate in E3 by keeping it as pure function

These are documented here for tracking; they don't block E1 but must be addressed in their respective epics.

## v1 Sources

| v1 File | v2 Destination | Lift Type |
|---------|---------------|-----------|
| `co-being/docker-compose.yml` | `docker-compose.yml` | Adapt (add TimescaleDB, PostgreSQL) |
| `co-being/packages/backend/schema/timescaledb.sql` | E1-T005 init script | Heavy adaptation |
| `co-being/packages/graph/src/neo4j-persistence.service.ts` | E1-T003 constraint setup | Extract constraint patterns |
