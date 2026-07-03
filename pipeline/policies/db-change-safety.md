# DB-Change Safety — the no-wipe gate

**Sylphie must stop having to wipe.** Her value is durable, accumulated
knowledge and identity (CON-2), behind frozen, versioned, migration-gated
embeddings (CON-3). A schema change that forces a database wipe destroys exactly
that. So any change touching a database must carry the data forward, not start over.

This policy turns that into an enforced gate. It applies to **all** work in the
repo — pipeline items and ad-hoc sessions alike — backed by the
`db-change-guard` hook (`pipeline/hooks/`) and the `dbcheck` detector
(`pipeline.py dbcheck`).

## The databases, and how a wipe happens

| Store | Container | Holds | Safe (incremental) path | Wipe path to avoid |
|---|---|---|---|---|
| Postgres 17 | `sylphie-postgres` | system/relational (Prisma models) | `prisma migrate` → `prisma/migrations/**` | edit `infra/postgres/init/**` + recreate volume |
| TimescaleDB | `sylphie-timescaledb` | events, pgvector embeddings | `infra/migrations/NNN-*.ts` | edit `infra/timescaledb/init/**` + recreate volume |
| Neo4j ×3 | `sylphie-neo4j-{world,self,other}` | the Self/Other/World KGs — her memory & identity | hand-written cypher in a `NNN-*.ts` dry-run/confirm script | structural cypher with no migration; container recreate |

The two ways data dies:

1. **`docker compose down -v`** (or any volume recreate). Init scripts under
   `infra/*/init/**` only run on a **fresh** volume, so "just edit the init SQL"
   to evolve a schema *implies* recreating the volume — a wipe. The hook blocks
   both the `down -v` and the init-script edit.
2. **`scripts/reset-data.ts --confirm`** — a deliberate schema-preserving data
   wipe. Legitimate occasionally, never silent. The hook blocks it unless approved.

**Neo4j is the sharpest edge:** the three identity graphs have no migration
framework, and structural changes (constraints, the `kg_label_fulltext` index)
strand data quietly. Treat every Neo4j structural change as a migration with a
backfill question, even though there's no tool forcing the shape.

## The house convention (already in the repo — follow it)

`infra/migrations/001-legacy-pattern-rescope.ts` and `scripts/reset-data.ts` are
the reference. Every migration script:

- **Dry-run by default** — prints the count + a sample and exits 0 with no writes.
- **`--confirm` (or `SYLPHIE_*_CONFIRM=1`) to apply live.**
- **Backs up before any destructive write** (`pg_dump` / `neo4j-admin database
  dump`) and **hard-stops (exit 1) if the backup fails.**
- **Idempotent** — a re-run is a no-op.
- **Documents a REVERSE** — the exact rollback, or how to restore the backup.
- **Traces to a contract decision** (`DEC-*` / append-only governance).

## The gate — what every DB-touching change must carry

A change "touches a DB" if it hits any surface in the table above, any `*.sql` /
`*.cypher`, a pgvector `vector(N)` dimension, or an embedding dim/version
constant. Such a change cannot leave **refine** or be marked **done** in
**review** without a migration plan (use `migration-plan.template.md`) that answers:

1. **Surfaces & impact class** — which stores; **additive** (safe) vs
   **destructive** (drop / rename / retype / dim-change / requires recompute).
2. **Forward migration via the incremental path** — a Prisma migration or an
   `infra/migrations/NNN-*.ts` script. **Never** an init-script edit as the
   delivery mechanism for a populated DB.
3. **Backfill assessment** — do existing rows/nodes need transform or recompute?
   (A changed embedding dim invalidates every stored vector → a re-embed plan or
   an explicit versioned-miss.) *"No backfill needed" must be justified as
   additive-only, never assumed.*
4. **Backup + REVERSE** — the pre-write backup step and the documented rollback.
5. **Continuity proof** — the **review** cog seeds representative data, applies the
   migration forward, and asserts the pre-existing data survived intact. This is
   the database analog of the live-smoke rule. Index/constraint changes must prove
   the index is actually rebuilt and picked up (the `kg_label_fulltext` lesson).
6. **No silent wipe** — if the change genuinely cannot preserve data, it needs an
   explicit append-only `decision` in `contract.yaml` acknowledging the loss and
   naming the backup taken — and then the auditable approval below.

## Enforcement

**The hook (`db-change-guard`, repo-wide).** Install once:
`node pipeline/hooks/install-db-guard.cjs`. On every `Write|Edit|Bash` it
hard-blocks wipe commands and init-script schema edits, reminds on other
DB-surface edits, and allows the migration path. Remove with `--uninstall`.

**Auditable approval (escape hatch).** A truly necessary destructive change is
allowed only when, *after* writing the migration plan, taking the backup, and
recording the contract decision, you either:

- run the command as `SYLPHIE_DB_CHANGE_APPROVED=1 <command>`, or
- create `infra/migrations/.db-change-approved` containing the authorizing
  decision id, make the change, then **delete the marker**.

Every override is logged to `pipeline/logs/db-guard.log`. The **sweep** cog flags
a lingering `.db-change-approved` marker so approval can't silently stay on.

**The detector (`pipeline.py dbcheck <id>`).** Reports whether a pipeline item
touches a DB surface and whether its migration plan is present, so a cog can't
forget. The **plan** cog routes DB-touching items to the `sentinel` agent and
adds a migration acceptance criterion; **refine** blocks on a missing/weak plan
(→ `replan`); **execute** must deliver via the incremental path; **review** runs
the continuity smoke (→ `refactor` on data loss without a recorded decision).
