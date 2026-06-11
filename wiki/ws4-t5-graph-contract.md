# WS4 Ticket 5 — Graph & Provenance Contract

**Author:** atlas · **Date:** 2026-06-10 · **Status:** design spec, ready for builder · Verified against live source at HEAD (5d8aba7). Implements the §7.1 decisions in `ws4-build-plan.md` (mythos, Jim's delegated authority); does not reopen them.

---

## 0. Findings that shape the contract

1. **The OKG path has its own Std-3 violation, independent of the WKG dual-write.** `person-model.service.ts:193` sets `confidence: fact.source === 'self_reported' ? 0.90 : 0.60` — keyed off `source`, NOT guardian status. Every self-reported fact (guardian or guest) lands at 0.90 in OKG. The OKG `writeFact` must be made guardian-aware.
2. **`isGuardian` exists at intake but is dropped before the write.** `intakeTurn` (communication.service.ts:261) receives it but calls `parseInput(text, sessionId, userId)` (:273) without it; `parseInput` (:156) calls `writeFastFacts(userId, facts)` (:192) without it. Thread: intakeTurn → parseInput → writeFastFacts → personModel.writeFact.
3. **WHO_AM_I recall reads OKG only** (`handleWhoAmI` :383 → `loadFacts` :391 → OKG MATCH at person-model:268). Deleting the dual-write does NOT regress WHO_AM_I.
4. **The dual-write IS a live cross-person leak vector:** `writeFactToWkg` (:755) creates `(:Entity{label:<userId>})-[rel]->(:Entity{label:<value>})` stamped GUARDIAN/0.90; `matchEntities` (wkg-context.service.ts:619) matches ALL Entity labels except :Word — so A's value-Entity can ground B's question GROUNDED at 0.90. Deletion closes this; existing rows need cleanup (§2.3).
5. **`provenance_type` is a free-form string** (no DB enum). Recognized vocabulary (confidence-decay.service.ts:114-119 + CANON): SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE. OKG `Attribute` has `source` (self_reported|observed|inferred) but no provenance_type today.
6. **`learned_patterns` is TimescaleDB/Postgres** (latent-space.service.ts:564); additive `ADD COLUMN IF NOT EXISTS` migrations are the established pattern (:583, :589). Patterns carry `knowledgeGrounding` but no person id.
7. **At replay the current speaker is available:** `frame.raw['person_model'].personId` (decision-making.service.ts:1033-1037).

---

## 1. OKG self-fact writes per speaker tier

Single rule in `person-model.service.ts:writeFact` (:189), which gains `isGuardian: boolean`. Confidence/provenance derive from `(fact.source, isGuardian)`, never identity-string matching.

| Case | Trigger | confidence | provenance_type (new on Attribute) | source |
|---|---|---|---|---|
| (a) Guardian self-fact | self_reported && isGuardian | **0.90** | **GUARDIAN** | self_reported |
| (b) Non-guardian self-fact | self_reported && !isGuardian | **0.60** | **SELF_REPORTED** (new label) | self_reported |
| Observed / inferred | source !== self_reported | **0.60** | OBSERVED / INFERENCE | unchanged |

- (b) uses exactly 0.60 (the Std 3 ceiling — an unconfirmed self-report is the strongest non-guardian evidence; lower would suppress legitimate guest recall). New `SELF_REPORTED` label justified: GUARDIAN would be the Std-5 violation we're fixing; INFERENCE lies about provenance. OKG-scoped only.
- Decay compatibility: SELF_REPORTED isn't in the confidence-decay CASE arms — those run on WORLD only; no edit needed. If OKG decay is ever added, use the ELSE rate (0.05). Do not add a dead CASE arm now.
- (c) Legacy tokenless-guardian (pre-Ticket-7): identical to (a) — correct, since only Jim can reach a tokenless localhost session. REQUIRED GUARD: tier must be computed from the turn's `isGuardian` flag, never re-derived from `userId === 'guardian'`. When Ticket 7 flips tokenless→guest, the same code path produces tier (b) with zero change.

Threading (builder): `writeFact(userId, fact, isGuardian)` — add `a.provenance_type = $provenance` to BOTH ON CREATE SET and ON MATCH SET of the MERGE (:217-229), keep max-merge confidence semantics (:226); `writeFastFacts(userId, facts, isGuardian)`; `parseInput` gains `isGuardian = true` param (default preserves legacy); `intakeTurn` passes its existing isGuardian at :273.

## 2. WKG dual-write deletion

### 2.1 Exact removal
In `writeFastFacts` (:712), `target === 'speaker'` branch (:719-730): REMOVE the `writeFactToWkg` push (:726-730); KEEP the `personModel.writeFact` push (:721-725, now with isGuardian). DELETE the orphaned `writeFactToWkg` method (:755-802). OUT of scope (unchanged per §7.1.2): `target === 'sylphie'` branch (:731-742), `writeFactToSelfKg` (:810), `writeFactToWkgCoBeing` (:856). No replacement — no world path in WS4 (WS5-T1). `factKeyToRelType`: remove only if grep shows it orphaned.

### 2.2 Consumer check — confirmed safe
WHO_AM_I is OKG-only. `matchEntities` behavior change (speaker value-Entities stop appearing as WKG grounding for anyone) IS the privacy fix. No node_id-keyed reader targets `person-<userId>`/`entity-<key>-<value>` ids.

### 2.3 Existing leaked rows — cleanup migration REQUIRED (idempotent, scoped)
```cypher
// Step 1 — strip speaker-fact edges + orphaned value nodes (WORLD instance)
MATCH (speaker:Entity {node_type: 'Person'})-[r]->(value:Entity)
WHERE speaker.node_id STARTS WITH 'person-'
  AND value.node_id STARTS WITH 'entity-'
DELETE r
WITH collect(DISTINCT value) AS vals
UNWIND vals AS v
WHERE NOT (v)--()
DELETE v;

// Step 2 — delete the speaker anchor Entities (leak roots; OKG Person models untouched)
MATCH (speaker:Entity {node_type: 'Person'})
WHERE speaker.node_id STARTS WITH 'person-'
  AND NOT (speaker)--()
DELETE speaker;
```
Safety: :Word/:Drive/:CoBeing/:ActionProcedure untouched; shared value nodes survive (orphan guard); idempotent. **Take a WORLD backup before first run (Sentinel).** Log deleted counts.

## 3. Latent-pattern person-scoping

**Invariant:** a pattern whose grounding came from person A's OKG must NOT replay GROUNDED to person B. World/WKG-grounded patterns (groundingPersonId NULL) may replay to anyone.

### 3.1 New field + write-time population
- DB: `grounding_person_id TEXT` nullable, no default. **NULL = world-scoped; non-null = OKG-scoped to that personId.**
- TS: `groundingPersonId: string | null` on LearnedPattern (:57 area), HotEntry (:103); optional on NewPattern (:78), default null.
- Write site (decision-making.service.ts:1429-1478): set groundingPersonId = current speaker's personId ONLY when the GROUNDED verdict was OKG-recall-derived (applyOkgRecallGrounding upgrade path :1036/:1092); WKG-context-grounded → null. **Conservative rule: if you cannot prove the GROUNDED verdict is WKG-backed, set it to the current speaker (person-scoped).** Asymmetric cost: false-person-scoping costs a re-deliberation; false-world-scoping leaks a person fact.

### 3.2 Replay-time check (insert at :1022, after groundingForCachedPattern, before applyOkgRecallGrounding)
```
currentPersonId = frame.raw['person_model']?.personId ?? null
gpid = pattern.groundingPersonId            // null = world-scoped
personScopeOk = (gpid === null) || (gpid === currentPersonId)
if (grounding === 'GROUNDED' && !personScopeOk) {
  grounding = 'UNKNOWN'                     // demote, don't suppress
  log('LATENT_PERSON_SCOPE_DEMOTION', { patternId, gpid, currentPersonId })
}
// then applyOkgRecallGrounding(currentPersonId, ...) runs as today — if B has
// the same fact in B's OWN OKG it re-GROUNDs honestly; demotion only strips
// the borrowed A-grounding.
```

### 3.3 Demoted replay returns
The response STILL FIRES (theater prohibition; no behavior cliff) — cached responseText delivered, knowledgeGrounding demoted GROUNDED→UNKNOWN (not SHRUG, not empty). groundingProvenance cleared unless re-grounded off the current speaker's own facts.

### 3.4 Schema migration
In ensureSchema() (:558) after the knowledge_grounding block (:588-592):
```sql
ALTER TABLE learned_patterns ADD COLUMN IF NOT EXISTS grounding_person_id TEXT;
```
**Existing rows: NULL = world-scoped — deliberate.** Legacy rows predate multi-person operation (guardian-only sessions); treating them person-scoped would lobotomize the entire warm layer the instant a second person connects, for zero privacy benefit. The conservative-when-ambiguous rule applies only to NEW writes. Document this asymmetry in the migration comment. Update hydrate() SELECT (:637), INSERT (:399-403, +$15), hotEntryToPattern (:681).

## 4. P0′ multi-person gate reset

Keep `clearFactsForPerson(userId)` unchanged. ADD `clearFactsForAllPersons(): Promise<number>`:
```cypher
MATCH (p:Person)-[:HAS_FACT]->(a:Attribute)
DETACH DELETE a
RETURN count(a) AS cleared
```
Plus `cache.clear()` and `interactionCounts.clear()`. Anchors preserved. Returns total deleted (-1 if Neo4j down). Corpus-independent (no person enumeration) — Ticket 7 calls it once in the hermeticity step.

## 5. CANON compliance table

| Standard | Before | After |
|---|---|---|
| Std 1 provenance | OKG Attribute lacks provenance_type; WKG speaker writes stamp GUARDIAN for everyone | Attribute gains explicit provenance_type; false-provenance writes deleted; patterns carry whose OKG backs a GROUNDED claim |
| Std 3 ceiling ≤0.60 | VIOLATED: all self-reported at 0.90 (OKG + WKG) | non-guardian 0.60; guardian 0.90 (legitimate exception); WKG 0.90 writes gone |
| Std 4 theater | n/a | demotion delivers the reflex, only down-stamps grounding — honest |
| Std 5 guardian asymmetry | VIOLATED/fictional (everyone gets GUARDIAN) | real: tier keyed off verified-JWT isGuardian; survives T7 flip unchanged |
| Std 2 / Std 6 | untouched | untouched |
| Three-graph isolation | VIOLATED: personal facts in shared WKG; reflex grounding leaks cross-person | OKG-only self-facts; person-scoped GROUNDED replay; hard wall restored |

## 6. Acceptance criteria

- **A1** zero speaker-keyed WKG Entities after a speaker fast-fact write (`node_id STARTS WITH 'person-' OR 'entity-'` count = 0).
- **A2** non-guardian self-fact → OKG Attribute confidence=0.60, provenance_type='SELF_REPORTED', source='self_reported' (unit, deterministic).
- **A3** guardian self-fact → 0.90 / GUARDIAN.
- **A4** person-scope replay isolation: unit — pattern {groundingPersonId:'personA', GROUNDED} replayed as personB → UNKNOWN, non-empty text; as personA → GROUNDED; {null} as personB → GROUNDED. Live two-JWT probe lands with Ticket 7.
- **A5** clearFactsForAllPersons after teaching ≥2 persons → 0 HAS_FACT→Attribute for ALL persons; anchors survive; caches empty.
- **A6** cleanup Cypher idempotent (2nd run deletes 0); :Word/:Drive/:CoBeing/:ActionProcedure counts unchanged.

## 7. Builder assignment

§1, §2, §3.4-schema, §4: Sonnet (mechanical/table-driven; low risk). §2.3 cleanup: Sonnet runs atlas's Cypher, Sentinel-style backup of WORLD first. **§3.1 write-time scoping + §3.2 replay demotion: opus-agent REQUIRED** — sits inside the Type-1 grounding-honesty core that the lesion work (a68a826) and C1 (93%) rest on; wrong edits regress C1, gut the warm layer, or leak. Do not let Sonnet invent the scoping predicate.

## Key files
- apps/sylphie/src/services/communication.service.ts — writeFastFacts :712, writeFactToWkg :755-802 (DELETE), parseInput :156, intakeTurn :261, handleWhoAmI :383
- apps/sylphie/src/services/person-model.service.ts — writeFact :189, clearFactsForPerson :312, + clearFactsForAllPersons
- packages/decision-making/src/latent-space/latent-space.service.ts — types :40-113, INSERT :399, ensureSchema :558, hydrate :622, hotEntryToPattern :681
- packages/decision-making/src/decision-making.service.ts — replay branch :1009-1053, write-time grounding :1429-1478, groundingForCachedPattern :2162
- packages/decision-making/src/wkg/wkg-context.service.ts — matchEntities :619
- packages/learning/src/pipeline/confidence-decay.service.ts — CASE arms :114/:164 (WORLD-only; no edit)
