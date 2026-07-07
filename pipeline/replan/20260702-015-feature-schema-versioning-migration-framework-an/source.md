# Feature: Schema versioning, migration framework, and boot/restore invariant checks

**Priority:** P0  ·  **Engineering level:** production
**Area / component:** persistence / all stores / boot sequence

## Why (required)
Code changes that touch data shape (a new node property, a new event field, a renamed
drive) currently drift silently — Neo4j has no enforced schema, so half the graph ends up
one shape and half another, and `ProvenanceMissingError` catches *missing* values but not
*malformed* ones. Silent corruption compounds until it poisons learning. State must be
treated like a production database: versioned, forward-only, reversible-via-snapshot
migrations, with hard verification before the decision cycle is allowed to run.

## What it should do (required)
- **`schema_version` stamped** in the snapshot manifest and in a metadata node/row in each
  store. Code refuses to boot against a version it doesn't understand — fail loud, never
  silently misread old data.
- **Migration scripts, not implicit drift:** every schema-affecting change ships a
  versioned, idempotent migration (`migrations/000N_<name>.ts`, vN → vN+1). On
  boot/restore, pending migrations apply in order and bump the stamp. Extend the existing
  Prisma discipline in `packages/shared` to Neo4j and the tensor manifest.
- **Neo4j migrations rewrite all existing nodes** to the new shape, followed by a
  validation pass asserting every node conforms — no read-time tolerance.
- **Post-restore / post-migration invariants** run before the decision cycle starts:
  (1) checksums match manifest; (2) cross-store referential integrity (OKG people
  referenced by recent events exist, graduated procedures exist in WKG, no dangling
  provenance); (3) schema conformance in every Neo4j store; (4) drive-state sanity
  (values in [-10,+1], pressure ≤ 12, no NaN); (5) tensor contract match (see
  feature-tensor-contract); (6) **floor integrity** — `ACTION_TYPE_DEFAULTS` and the veto
  logic match their expected checksum. Any failure → refuse to start, surface it, fall
  back to last good snapshot. Never run on unverified state.

## Scope hints
`infra/**` and migration tooling (owner: `sentinel`, conceptual reviewer `ashby`);
`packages/shared/**` Prisma conventions (`forge`); boot-sequence checks near the existing
startup checks in `apps/sylphie` (`forge`); Neo4j validation queries (`atlas` consult for
WKG shapes).

## Dependencies (required)
Depends on **feature-snapshot-restore** (manifest + restore path must exist to hang the
invariants on). Conflict risk: touches the same manifest code as snapshot-restore — run
sequentially, not concurrently.

## Database impact (required)
**Touches a database / schema / migration?** yes
Adds metadata (schema_version) to all stores (Postgres, Timescale, all Neo4j instances)
and introduces the migration framework itself. Additive; existing data gets a backfill
migration to stamp v1. Requires a migration plan per the db-change-safety policy.

## Acceptance — how we'll know it works (required)
1. Given a snapshot with an unknown `schema_version`, when the system boots against it,
   then boot is refused with a loud, specific error (no partial start).
2. Given a pending migration, when the system boots, then the migration applies once
   (idempotency verified by double-run), the stamp bumps, and a validation pass confirms
   every node/row conforms to the new shape.
3. Given a deliberately corrupted restore (bad checksum, dangling cross-store ref, drive
   NaN, or tampered executor defaults), when the invariant pass runs, then the cycle
   refuses to start and names the failed invariant.
4. Floor-integrity check: modify a byte of the veto logic → boot refuses with a
   floor-checksum failure (CANON Std-6 tie-in).

## Non-goals / scope guard (required)
No down-migrations beyond restore-from-snapshot (milestone snapshots are the undo path).
No retro-migration of already-wiped historical state. No tensor-shape handling (separate
feature). Do not modify `infra/*/init/**` without the db-change-guard approval flow.

## Source / references
`docs/future/sylphie-persistence-migration-plan.md` §3, §5, §7 (build order item 2).
