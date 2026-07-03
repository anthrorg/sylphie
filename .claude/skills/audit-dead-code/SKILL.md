---
name: audit-dead-code
description: Whole-codebase scan for dead code, stubs, placeholders, and theater. Combines codebase-pkg graph reachability (CALLS + RESOLVED_CALL + CALLS_ENDPOINT) with a source-pattern sweep for not-implemented bodies, TODO/FIXME, mock returns, and zero-vector placeholders — then reads each candidate file in full to confirm before flagging. Writes a report under docs/audits/ and annotates the graph. Use to find what isn't really wired.
---

# Audit: Dead Code / Stubs / Placeholders

Find the parts of the codebase that **don't really do anything yet**: unreachable
exported code, stubs, placeholders, and theater (code that fakes a result instead of
producing one). This is the honesty audit — it backs the project value that the
[stub inventory](../../../sylphie-stub-inventory.md) is real and complete, and it
supports CANON's **Theater Prohibition**.

This skill is **read + annotate only**. It never deletes code. Its output is a
reviewable report plus graph flags; acting on any finding is a separate, human-gated step.

## When to use

- Periodically, to keep `sylphie-stub-inventory.md` honest.
- Before declaring a workstream "done" — to catch silent stubs.
- After a large merge, to find newly-orphaned exports.

## Scope

**Default: the whole first-party codebase** — all 11 packages in `.mcp.json`
(`apps/sylphie`, `apps/drive-server`, `packages/{decision-making,drive-engine,learning,planning,shared,supervisor,cognition-service,perception-service}`, `frontend`).
Narrow with `--package <name>` for a single scope.

> **This can take time.** A full sweep reads many files in full. Run it as a
> **Workflow** with one agent per package (fan-out), each returning structured
> findings; the orchestrator merges, de-dupes, and writes the report + graph
> annotations. Do not try to hold all 476 files in one context.

## Prerequisites

1. Graph synced and analyzed — run `/sync-pkg` then `/infer-pkg-connections`
   (specifically `di-calls` + `cross-language`, which populate the reachability
   edges this skill consumes). Without them, reachability is a high false-positive.
2. Neo4j reachable. Run Cypher via:
   ```bash
   docker exec codebase-pkg-neo4j cypher-shell -u neo4j -p "$CODEBASE_PKG_NEO4J_PASSWORD" "<query>"
   ```
   The password lives in the `codebase-pkg` env block of `.mcp.json` (same value the
   other `*-pkg` skills use). Export it before running, or substitute inline.

## Discovery protocol (mandatory)

Per the repo's discovery protocol: **locate via `codebase-pkg`, then `Read` the whole
file before flagging anything.** A graph reachability flag or a regex hit is a *lead*,
never a verdict. Every candidate that lands in the report must have had its source read
in full and confirmed by judgment.

---

## Workflow

### Phase 1 — Graph reachability (leads)

Reuse the reachability flags from `/infer-pkg-connections`. Pull the medium-confidence
unreached exports (these already honor `CALLS`, `RESOLVED_CALL`, `CALLS_ENDPOINT`):

```cypher
MATCH (f:Function)
WHERE f.possiblyDead = true AND f.deadConfidence = 'medium'
RETURN f.name AS name, f.filePath AS filePath, f.domain AS domain
ORDER BY f.filePath
```

If `infer-pkg-connections` hasn't been run this session, run its `di-calls` →
`cross-language` → `dead-code` analyses first.

### Phase 2 — Stub / placeholder / theater source sweep (leads)

These are NOT visible to the call graph — they need a content scan. Use
`codebase-pkg`'s `searchContent` first (it tells you the containing function/type),
then `Grep` for breadth. Sweep for, at minimum:

- **Not-implemented:** `throw new Error\(['"]not impl`, `NotImplementedError`,
  `raise NotImplementedError`, `TODO\(`, `unimplemented`.
- **Markers:** `TODO`, `FIXME`, `HACK`, `XXX`, `// stub`, `# stub`, `placeholder`,
  `@deprecated`, `for now`, `temporary`.
- **Theater / fake returns:** hardcoded `return true`/`return 0.6`/`return []` where a
  computation is implied, `return null` from a function typed to return data,
  **zero-vector placeholders** (`new Array(.*).fill(0)`, `np.zeros`, `torch.zeros`
  returned as an embedding), `Math.random()` stand-ins, mock/fixture data returned
  from production paths.
- **Empty bodies:** functions whose body is only `pass`, `...`, `return`, or a single
  log line, yet whose name implies real work.

Cross-reference every confirmed stub against `sylphie-stub-inventory.md`: is it already
listed (known) or **newly discovered** (the inventory is drifting)?

### Phase 3 — Confirm by reading (verdict)

For each lead from Phase 1 & 2: **`Read` the whole file.** Classify it as one of:

- `confirmed-dead` — exported, genuinely unreached, not an entry point (not a
  decorator hook, DI service, CLI `main`, framework lifecycle, or test helper).
- `confirmed-stub` — runs but returns a placeholder / not-implemented / theater value.
- `false-positive` — reachable via a path the graph doesn't model (factory, dynamic
  dispatch, JSX render, event name, re-export). Record *why* so the next run is faster.

Be adversarial: the default for an ambiguous case is `false-positive`. A finding is only
real if you can name the evidence (the placeholder line, the missing caller).

### Phase 4 — Annotate the graph

Idempotent `MERGE`/`SET`. Keep these distinct from `infer-pkg-connections`'
`possiblyDead`:

```cypher
MATCH (f:Function {filePath: $filePath, name: $name})
SET f.isStub = $isStub,                         // true for confirmed-stub
    f.stubKind = $stubKind,                      // 'not-implemented'|'placeholder'|'theater'|'empty'|'dead'
    f.stubEvidence = $evidence,                  // the line / reason, short
    f.auditedDeadAt = timestamp()
```

For confirmed theater specifically, also tag `f.theaterRisk = true` so a CANON pass can
find it.

### Phase 5 — Report

Write `docs/audits/dead-code.md` (overwrite each run; the graph holds history):

```
# Dead Code / Stub Audit — <commit short sha>

## Summary
Confirmed stubs: N   |  Confirmed dead: N  |  Theater-risk: N
New (not in stub-inventory): N

## Confirmed stubs / theater   (action: wire or document)
- `pkg/file.ts:line` `FnName` — <stubKind> — <evidence> — [inventory: known|NEW]

## Confirmed dead exports     (action: remove or justify)
- `pkg/file.ts:line` `FnName` — unreached; not an entry point

## Stub-inventory reconciliation
- Drift: <stubs found that the inventory omits>
- Stale: <inventory entries no longer present>

## Dismissed leads (false-positives + why)   // keeps the next run honest
```

---

## Key rules

- **Read the file before flagging.** No exceptions. Regex/graph hits are leads only.
- **No deletions, ever.** This skill annotates and reports; humans act.
- Decorator-driven (`@Cron`, `@OnEvent`, `@SubscribeMessage`, gateways), DI services,
  CLI `main*`, framework lifecycle (`onModuleInit`), and test helpers are **entry
  points** — not dead.
- Prefer `false-positive` when unsure; record the reason.
- Reconcile against `sylphie-stub-inventory.md` every run — surfacing drift is half the value.
- Reset annotations: `MATCH (f:Function) REMOVE f.isStub, f.stubKind, f.stubEvidence, f.theaterRisk, f.auditedDeadAt`.
