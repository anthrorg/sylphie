# Plan — 20260702-008: WKG write/read plumbing bugs

Source: `docs/audits/repo-bug-audit-2026-07-02.md` §2. Source-trace commit `228df73`;
verified against working tree at HEAD (`13a33e8`, 2026-07-06). All file/line claims below
were independently re-checked by reading the named files in full — not taken on faith.

## Verification of source claims

| # | Claim | Verdict | Notes |
|---|---|---|---|
| 1 | Dedup boost bypasses 0.60 ceiling — `wkg-context.service.ts:823` `Math.min(1.0, existingConf + 0.05)` | **CONFIRMED** | Exact line/code. Contrast `reinforceFactNode()` at :740 which correctly uses `Math.min(CONFIDENCE_THRESHOLDS.ceiling, recomputed)`. |
| 2 | Contradiction scanner is a structural no-op | **CONFIRMED, deeper than stated** | `contradiction-scanner.service.ts:108` matches `(:ActionProcedure {id:$id})-[:CONTRADICTS]-(c)` reading `c.claim/c.existingFact/c.confidence` off the **neighbour node**. `detect-contradictions.service.ts:151-169` MERGEs `(a)-[c:CONTRADICTS]->(b)` between the two **entity/candidate endpoints** and stores `claim/existingFact/confidence` on the **edge** `c`, never touching an `ActionProcedure` node at all. So even a property-name fix alone (`id`→`node_id`) cannot make this fire — there is no code path that ever attaches a CONTRADICTS edge to a procedure node. The real fix has to traverse `ActionProcedure -[:INVOLVES]-> entity -[:CONTRADICTS]- otherEntity` and read the props off the edge. |
| 3 | `writeEntity()` returns a phantom `node_id` | **CONFIRMED** | `wkg-context.service.ts:364-436`: generates `entity-${uuid}` locally, runs `MERGE ... RETURN node.node_id AS nodeId` but **never captures the query result** — the function returns the local `nodeId` variable unconditionally at line 401/428, regardless of whether MERGE matched an existing node (ON CREATE sets node_id only) or the APOC/no-APOC branch. |
| 4 | `writeEntity()` RESEARCH_ENTITY handler logs success on zero rows | **CONFIRMED** | `action-handler-registry.service.ts:512-538`: `writeRelationship()` is called with the phantom id from (3); its `MATCH (a {node_id: $sourceId}), (b {node_id: $targetId})` matches nothing, MERGE never runs, no error thrown; the handler's final `this.logger.log(...written to WKG...)` at the end of the block is unconditional. |
| 5 | RELIEVES drive-links are guaranteed no-ops (no `:Drive` nodes ever created) | **REFUTED** | `apps/sylphie/src/services/wkg-bootstrap.service.ts` (`WkgBootstrapService implements OnModuleInit`, `onModuleInit()` → `bootstrap()`) MERGEs 12 `:Drive {node_id: 'drive:<name>'}` nodes with `drive_name` set `ON CREATE` (lines 111-134), running automatically at app startup against the same Neo4j WORLD instance `writeActionProcedure()` targets. So `MATCH (d:Drive {drive_name: $driveName})` at `wkg-context.service.ts:900` **does** match post-bootstrap. The source's claim that no `:Drive` writer exists is factually wrong, and the associated non-goal/architect-call ("decide whether RELIEVES should link to a real representation or be removed") is moot — it already links to a real representation. **No ticket for this.** The one real residual defect in that code block is generic: `writeActionProcedure`'s `INVOLVES`/`RELIEVES` MERGE calls (lines 890-903) don't check whether the MERGE actually matched anything before the unconditional success log at :915-918 — that's folded into the write-honesty ticket below, not a RELIEVES-specific fix. |
| 6 | `matchProcedures()` reads only `p.triggerContext`, misses `trigger_context` | **CONFIRMED, and the fix pattern already exists in-repo** | `wkg-context.service.ts:1147-1173` (query at :1152-1155) only reads `p.triggerContext`. Planning writes `trigger_context` (`procedure-creation.service.ts:92`, `constraint-validation.service.ts:245`). `action-retriever.service.ts:318-332` — the *other* procedure reader — already coalesces **three** writer conventions (seed bootstrap: `p.id`/`p.provenance`/`p.triggerContext`; planning: `p.node_id`/`p.provenance_type`/`p.trigger_context`; WKG write: `p.node_id`/`p.provenance_type`/`p.triggerContext`) via `coalesce(p.id, p.node_id)`, `coalesce(p.triggerContext, p.trigger_context)`, `coalesce(p.provenance, p.provenance_type)`. `matchProcedures()` should mirror that exact pattern, not just patch `triggerContext`. |
| 7 (lower) | `reinforceFactNode()` non-transactional read-modify-write | **CONFIRMED** | Two separate `session.run()` calls (lines 700-706, 745-752), no explicit transaction between the read and the write. |
| 7 (lower) | Bootstrap seeds minted at 0.60 vs documented 0.40 base | **CONFIRMED** | `action-retriever.service.ts:519` hardcodes `const BASE_CONFIDENCE = 0.60`, but the file's own header doc (lines 12-14) and `provenance.types.ts:70` ("SYSTEM_BOOTSTRAP → 0.40, treat as SENSOR") both document 0.40. |
| 7 (lower) | `getSubgraph()` discards neighborhood rels + string-interpolates `depth` | **CONFIRMED** | `wkg-context.service.ts:278-320`: computes `allRels` via the variable-length path but never returns it; instead calls `this.getRelationships(session, entityIds)` with the *original* entity ids only, so edges to/from newly-discovered neighbours are silently dropped. `depth` is directly template-interpolated into the Cypher range (`[r*1..${depth}]`) rather than parameterized. |
| 7 (lower) | `writeEntity` APOC-fallback drops all properties + no ceiling on ON MATCH lift | **CONFIRMED** | Fallback query (lines 405-426) omits `n += $properties` entirely; both branches' `ON MATCH SET n.confidence = CASE WHEN $confidence > n.confidence THEN $confidence ELSE n.confidence END` has no ceiling clamp. |
| 7 (lower) | `writeRelationship()` ignores `properties` param, logs success on zero-row no-op | **CONFIRMED** | `NewRelationship.properties` (line 120) is never referenced in the Cypher at lines 447-463; `this.logger.debug('WKG relationship written...')` at :465 is unconditional regardless of match count. |
| 7 (lower) | `promoteCandidate()` reports infra failure as `not_found` | **CONFIRMED** | The `catch` block at lines 615-626 returns `reason: 'not_found'` for a thrown exception, indistinguishable from the legitimate "no candidate matched" case at lines 584-599, even though `reason: 'unavailable'` already exists as a distinct value used elsewhere in the same function. |
| 7 (lower) | `getBaseContext()` defaults missing confidence to 1.0 | **CONFIRMED** | Line 1032: `confidence: r.get('confidence') ?? 1.0`. |
| 7 (lower) | Promoted candidates keep `node_type: 'Candidate'` | **CONFIRMED** | `promoteCandidate()`'s `SET` clause (lines 566-572) relabels `:Candidate`→`:Entity` and updates `provenance_type`/`confidence`/`promoted_*` but never sets `n.node_type`, so the property drifts from the label. |

**New finding surfaced during verification (not in source.md):** none that change scope — the
"three writer conventions" mechanism for bullet 6 above is a fuller diagnosis of the same
bug the source already flagged, using the existing `action-retriever.service.ts` coalesce as
the reference fix pattern, not a new defect.

## Existing contract overlap

- **No ticket in `planning/contract.yaml` already covers this file/theme.** Checked for
  `wkg-context`, `contradiction-scanner`, `writeEntity`, `TK-104`, `RELIEVES`,
  `confidence ceiling` — no hits against this scope.
- `EP-27` ("Codebase audit remediation (2026-06-21) — CANON Std-6 drive_rules lockdown +
  audit findings", parent `FEAT-3`, `pipeline_item: 20260625-002`, in_progress) is the
  nearest sibling — same "codebase audit remediation" genre, but scoped to a **different**
  audit doc (2026-06-21) and a different subsystem (Postgres `drive_rules` RLS, via
  TK-153/154/155). Not the same finding; recommend a **new epic** rather than attaching to
  EP-27, since EP-27's scope is Std-6/RLS specific and this item is WKG Neo4j
  write/read-path correctness — attaching would blur two unrelated audits under one epic
  title. Record the relationship in the new epic's `intent` for traceability.
- `TK-104` (`EP-20`, done) fixed the *rank-time* seed-greet runaway-reinforcement class the
  source explicitly calls out as the sibling of this *write-time* ceiling escape ("coordinate
  so they don't double-correct"). No overlap in code — TK-104 touched arbitration ranking,
  this item touches the WKG write path — just a coordination note, carried into ticket 008-a's
  `non_goals`.
- `existing_contract_overlap`: **EP-27** (sibling audit epic, not reused), **TK-104** (coordination-only, not reused).

## Split recommendation

None. All five ticket-worthy defects are in one file (`wkg-context.service.ts`) plus one
directly-coupled cross-file pair (`contradiction-scanner.service.ts` /
`detect-contradictions.service.ts`) plus one caller (`action-handler-registry.service.ts`),
all from the same audit finding block, all owned by the same domain expert (`atlas`, WKG
code, per CLAUDE.md work-trio table — `packages/decision-making/src/wkg/**`). No unrelated
concerns are bundled in `source.md`; nothing to split out.

## Proposed epic

**EP-WKG-PLUMBING** — "WKG write/read plumbing correctness — confidence-ceiling escape,
contradiction gate, phantom node_ids, property-name drift" (parent: `FEAT-3`, or wherever
`docs/audits/repo-bug-audit-2026-07-02.md` findings are being staged; coordinator to confirm
parent feature at write time — this plan does not touch `contract.yaml`).
Owner: `atlas` / conceptual reviewer `scout` / code reviewer `code-reviewer` (per the
`packages/decision-making/src/wkg/**` row of the work-trio table).

## Tickets

### 20260702-008-a — Confidence-ceiling escape: route the dedup-boost path through `computeConfidence()` (CANON Std-3/Std-6)

- **priority:** P1 (source states severity high / priority P1 explicitly; this is a
  correctness bug, not a security or data-loss event by the coordinator's own P0 test —
  no data is lost, but arbitration ranking integrity is compromised, which is why source
  itself still calls it out as the most severe item in the batch)
- **engineering_level:** production
- **depends_on:** []
- **files_in_scope:** `packages/decision-making/src/wkg/wkg-context.service.ts` (`writeActionProcedure` dedup branch, lines ~795-846); `infra/migrations/003-wkg-dedup-confidence-reclamp.ts` (new, backfill script — see migration.md)
- **acceptance_criteria:**
  - given: an `ActionProcedure` node with `provenance_type` `INFERENCE` or `LLM_GENERATED` and confidence 0.55, when: a second `writeActionProcedure()` call Jaccard-matches it (similarity > 0.70), then: the persisted confidence is computed via the shared `computeConfidence()` (same ACT-R function `reinforceFactNode()` uses) and clamped to `CONFIDENCE_THRESHOLDS.ceiling` (0.60) — never a bespoke `+0.05` — provable by a unit test asserting the persisted value never exceeds 0.60 across 20 repeated dedup hits (`yarn workspace @sylphie/decision-making test wkg-context` or the package's equivalent test script)
  - given: an `ActionProcedure` already at confidence >= 0.60 via legitimate guardian confirmation (`GUARDIAN`/`GUARDIAN_APPROVED_INFERENCE`/`TAUGHT_PROCEDURE` provenance), when: a dedup match boosts it, then: it is never demoted below its current value (mirrors the never-demote floor already proven in `reinforceFactNode()`) — unit test
  - given: the repo's existing over-boosted `ActionProcedure` nodes in a populated WORLD graph (confidence > 0.60, non-guardian provenance, stamped by this bug before the fix), when: `infra/migrations/003-wkg-dedup-confidence-reclamp.ts` runs in dry-run mode (default, no `--confirm`), then: it prints the affected node count + a confidence sample and makes zero writes (exit 0)
  - given: the same population, when: the script runs with `--confirm`, then: every matching node's confidence is clamped to 0.60, the run is idempotent (re-run is a no-op), and a pre-write Neo4j WORLD backup (`neo4j-admin database dump`) is taken first, hard-stopping if the backup fails — proven by the migration's own dry-run→confirm→re-run smoke
- **non_goals:**
  - Changing TK-104's rank-time seed-greet de-prioritization logic (arbitration/ranking) — this ticket is write-time only; coordinate release notes so the two fixes aren't mistaken for double-correcting the same symptom
  - Semantic/fuzzy dedup at write time (needs the embedding service — out of scope per source's own §1.3 KNOWN LIMITATION note)

### 20260702-008-b — WKG entity/relationship write-path correctness & honesty (`writeEntity`, `writeRelationship`, `writeActionProcedure` link writes, RESEARCH_ENTITY handler)

- **priority:** P1
- **engineering_level:** production
- **depends_on:** []
- **files_in_scope:** `packages/decision-making/src/wkg/wkg-context.service.ts` (`writeEntity` lines 364-436, `writeRelationship` lines 441-471, `writeActionProcedure` INVOLVES/RELIEVES loop lines 890-903); `packages/decision-making/src/action-handlers/action-handler-registry.service.ts` (RESEARCH_ENTITY handler, lines 512-545)
- **acceptance_criteria:**
  - given: a `writeEntity()` call whose label already exists (MERGE takes the ON MATCH branch), when: it returns, then: the returned id is the node's actual persisted `node_id` (read from the query's own `RETURN node.node_id`/`RETURN n.node_id`, not the locally-generated uuid) — unit test covering both the APOC and no-APOC (catch) branches
  - given: the APOC-unavailable fallback branch (lines 404-426) creating a brand-new node, when: it runs, then: `entity.properties` are persisted on the created node (currently silently dropped) — unit test
  - given: a `writeEntity()` ON MATCH branch where `$confidence` exceeds `CONFIDENCE_THRESHOLDS.ceiling` and the existing node has no guardian confirmation, when: the MERGE runs, then: the lifted confidence is clamped to the ceiling (mirrors 008-a's fix, applied to the entity-write path) — unit test
  - given: a `writeRelationship()` call with a non-empty `properties` map, when: the MERGE runs (either branch), then: those properties are actually set on the relationship — unit test
  - given: a `writeEntity()` call on a pre-existing label followed by a `writeRelationship()` using its returned id, when: both complete, then: the id resolves to a real node and the relationship MERGE actually creates the edge (integration test against a live/test Neo4j) — this is the source's own headline acceptance criterion
  - given: any `writeEntity`/`writeRelationship` call (including the `writeActionProcedure` INVOLVES/RELIEVES loop and the RESEARCH_ENTITY handler's per-node/per-edge writes) whose MERGE matches zero rows, when: the call returns, then: the caller does not log an unconditional success message — it inspects the query's `summary.counters` (or an equivalent affected-row signal) and logs/returns a distinguishable "no-op" outcome instead of a blanket "written" claim — unit test on `RESEARCH_ENTITY` asserting the logged/returned counts reflect actual graph mutations, not input-array lengths
- **non_goals:**
  - Reworking `promoteCandidate()` (that already has its own dedicated ticket, 008-e, for its narrower `not_found` vs infra-failure distinction)
  - Adding a formal Neo4j migration/constraint framework — this ticket is application-code query correctness only
- **note:** touches the same file as 008-a in a different function (`writeEntity`/`writeRelationship` vs `writeActionProcedure`'s dedup branch); low overlap risk but sequence-aware if built in parallel.

### 20260702-008-c — Contradiction scanner: match the real CONTRADICTS shape so the coherence gate can fire

- **priority:** P1
- **engineering_level:** production
- **depends_on:** []
- **files_in_scope:** `packages/decision-making/src/arbitration/contradiction-scanner.service.ts`; test fixtures cross-referencing `packages/learning/src/pipeline/detect-contradictions.service.ts` (read-only reference, no changes to the learning package)
- **acceptance_criteria:**
  - given: an `ActionProcedure` node linked via `[:INVOLVES]` to an entity that has a real `[:CONTRADICTS]` edge to another entity (the exact shape `detect-contradictions.service.ts:151-169` actually writes: edge-level `claim`/`existingFact`/`confidence` props, entity/candidate endpoints, never touching the procedure node directly), when: `ContradictionScannerService.scan()` runs for that procedure, then: it returns `hasContradictions: true` with the contradiction's claim/existingFact/confidence read off the CONTRADICTS **edge** — fixture-backed test seeding this exact shape (not the old, never-written `(:ActionProcedure)-[:CONTRADICTS]-(c)` shape)
  - given: the query's procedure-id parameter, when: matching the procedure node, then: it matches on `node_id` (the actual property `ActionProcedure` nodes carry, per `ActionProcedureData.id` at the type level mapping to the graph's `node_id`), not the never-set `id` property
  - given: a procedure with no CONTRADICTS-bearing entity in its INVOLVES neighborhood, when: the scan runs, then: it returns a clean `hasContradictions: false` (no regression on the already-correct empty-case handling)
- **non_goals:**
  - Extending `detect-contradictions.service.ts` (learning package) to write CONTRADICTS edges directly onto `ActionProcedure` nodes — the traversal-based fix (procedure → INVOLVES → entity → CONTRADICTS) is the chosen, non-invasive design; changing the learning writer's edge model is out of scope and would be a separate cross-package decision
  - Broadening `ANTONYM_MAP` beyond `LIKES`/`DISLIKES` — no evidence that's part of this bug

### 20260702-008-d — `matchProcedures()`: coalesce all three procedure-writer property conventions

- **priority:** P1
- **engineering_level:** production
- **depends_on:** []
- **files_in_scope:** `packages/decision-making/src/wkg/wkg-context.service.ts` (`matchProcedures()`, lines 1147-1173)
- **acceptance_criteria:**
  - given: a planning-created procedure written with `trigger_context` (snake_case, per `procedure-creation.service.ts:92`), when: `getContextForFrame()` runs on matching input, then: the procedure appears in the `matchProcedures()` results — the exact reproduction case from source
  - given: a bootstrap seed procedure written with `p.triggerContext` + `p.id` + `p.provenance` (the seed-writer convention, `action-retriever.service.ts:551-576`), when: `matchProcedures()` runs, then: it also matches and returns a non-null `nodeId`/`provenance` for that node — mirroring the `coalesce(p.id, p.node_id)` / `coalesce(p.provenance, p.provenance_type)` pattern `action-retriever.service.ts:324-332` already uses for the arbitration retrieval path (this fixes the property drift at its root — three writer conventions, one coalescing reader — not just the `triggerContext` spelling named in source)
  - given: a WKG-written procedure (`writeActionProcedure`, camelCase `triggerContext` + `node_id` + `provenance_type`), when: `matchProcedures()` runs, then: it continues to match exactly as before (no regression)
- **non_goals:**
  - Normalizing all three writers onto one property convention — that's a larger migration (would need a backfill across every existing `ActionProcedure` node); this ticket only fixes the reader to be convention-agnostic, matching the existing precedent in `action-retriever.service.ts`

### 20260702-008-e — WKG write/read-path hygiene sweep (grouped low-severity items from source's "Lower" bullet)

- **priority:** P2
- **engineering_level:** production
- **depends_on:** []
- **files_in_scope:** `packages/decision-making/src/wkg/wkg-context.service.ts` (`reinforceFactNode`, `getSubgraph`, `promoteCandidate`, `getBaseContext`); `packages/decision-making/src/action-retrieval/action-retriever.service.ts` (bootstrap seed `BASE_CONFIDENCE`)
- **acceptance_criteria:**
  - given: a concurrent guardian promotion racing a `reinforceFactNode()` read-modify-write on the same node, when: both complete, then: the result is not silently stomped — either wrapped in an explicit Neo4j transaction or rewritten as a single atomic Cypher statement — test simulating the race via two interleaved sessions
  - given: the bootstrap seed procedure writer, when: it runs, then: it stamps `BASE_CONFIDENCE = 0.40` (matching the file's own documented `SYSTEM_BOOTSTRAP` base and `PROVENANCE_BASE_CONFIDENCE.SENSOR`), not the current hardcoded 0.60 — unit test asserting the seeded confidence value
  - given: a call to `getSubgraph(entityIds, depth)` where the neighborhood contains nodes not in the original `entityIds`, when: it returns, then: relationships touching those neighbour nodes are included in the result (not silently dropped by the redundant `getRelationships(entityIds)` call) — integration test
  - given: `getSubgraph()`'s `depth` parameter, when: the Cypher is built, then: it is passed as a bound parameter (or validated as a small positive integer before interpolation) rather than raw string-interpolated into the query — test/lint asserting no unvalidated interpolation
  - given: `promoteCandidate()` throwing on a genuine Neo4j/infra error (the `catch` block, lines 615-626), when: it returns, then: the result is distinguishable from the legitimate "no candidate matched" no-op (e.g. a distinct `reason` value, reusing or extending the existing `'unavailable'`/new `'error'` reason) — unit test
  - given: `getBaseContext()` reading a node with no `confidence` property, when: it builds the entity, then: it defaults to a value that does not imply full certainty (e.g. 0.0 or the node's provenance-tier base) instead of `1.0` — unit test
  - given: `promoteCandidate()` relabeling a node `:Candidate` → `:Entity`, when: promotion completes, then: `n.node_type` is updated to `'Entity'` (currently left as `'Candidate'`, drifting from the label) — unit test
- **non_goals:**
  - Any change to the guardian-gate logic itself (CANON Std-5) — this ticket is transactionality/value-hygiene only, not access control

## Open questions

None blocking. The one genuine judgment call in the source (the confidence backfill for
already-over-boosted procedures) is resolved above via a standard dry-run/`--confirm`
migration script (ticket 008-a + migration.md) rather than left open, per
`pipeline/policies/db-change-safety.md`'s backfill-assessment requirement. The RELIEVES
architect-call non-goal in source is moot per the verification table (Drive nodes already
exist) — no open question needed there either.

## Routing recommendation

**refine.** All five tickets are atomic, have runnable-check acceptance criteria, and share
one clear owner (`atlas`). No design fork requiring an architect/Jim ruling.
