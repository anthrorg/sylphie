# Wave 3 — WS5.5 / Tier-4a: World-fact & Three-Graph Isolation

**Branch:** `feat/wave3-three-graph-isolation` (off `main` @ `cda461a`)
**Compiled:** 2026-06-15 (mythos-verified decomposition, Jim's decisions folded in)
**Goal:** Close the CANON Std-3 three-graph isolation breach (§2.8) WITHOUT reopening the Std-3/Std-5 holes WS4 closed. Small chunks, dependency-ordered, **zero deferred items**.

## Central design (decision-grade)

§2.8 (person-fact WKG leak) and ws5-t1 (world-fact promotion) are the **same mechanism**: one new graph object, a **`:Candidate` node in the WORLD Neo4j graph**.

- Conversation-derived proper nouns are minted as `:Candidate` (provenance `CANDIDATE`, confidence ≤0.60, `grounding_person_id` = speaker), **not** live `:Entity`.
- `:Candidate` is excluded from all WKG grounding read-paths → never produces a GROUNDED label → §2.8 closed.
- Guardian-only confirmation promotes `:Candidate → :Entity` (reuses existing `guardian_feedback` channel; no new auth surface) → ws5-t1 closed.
- `target:'world'` classifier routes genuine world-facts into the same staging store instead of dropping them.

In-pattern (Neo4j MERGE + one filter clause + existing guardian channel); no re-architecture.

## Verified findings (HEAD cda461a)
- §2.8 reproduces. **PRIV.1 gate can't catch it** — it uses a lowercase nonce; the extractor only mints *capitalized* proper nouns. New probe PRIV.3 must use a capitalized multi-noun nonce.
- Buried dep: INPUT events don't carry `speakerId` (it's in scope but unthreaded) → needs C2 before C3.
- A Prisma `CandidateWorldFact` table would be the only Prisma domain table → wrong; `:Candidate` Neo4j node is in-pattern.
- Durable recall handler is structurally independent of the isolation cluster.

## Jim's decisions (2026-06-15)
1. **Legacy rescope → data wipe.** Jim authorized wiping memory/data as long as schema/structure remains → C7 becomes a clean data-reset utility, not a 293-row migration.
2. **Latent drive/face → fail-loud now, separate index next wave.** C6 = audited skip only.
3. **Durable recall handler → IN (C8), do not defer.** Resolve its 3 open design Qs up front.

## Chunks (DAG: C0‖C1‖C2 → C3 → {C4,C5,C7}; C6 independent; C8 needs C0)

| # | Scope | Owner | Prereqs | Acceptance |
|---|---|---|---|---|
| C0 | `:Candidate` contract + exclude from ALL WKG grounding read-paths | atlas | — | Unit: candidate never grounded; entity still is |
| C1 | `target:'world'` classifier | learning | — | Unit: world vs speaker subjectHint |
| C2 | `speakerId` into INPUT events | vox | — | Integ: payload carries speakerId |
| C3 | Mint `:Candidate` scoped/capped, not `:Entity` | learning+atlas | C0,C1,C2 | **Gate PRIV.3** two-JWT probe + staged-candidate control |
| C4 | Guardian promotion `:Candidate→:Entity` | atlas+vox | C3 | Integ: guardian promotes; non-guardian rejected (Std-5) |
| C5 | Consolidation `episode.source`+visualContext (§2.12); visual→`:Candidate` | learning | C0,C3 | Regression: provenance from source, not GROUNDED |
| C6 | Latent drive/face fail-loud audited skip | drive | — | Unit: skip logged/counted, not silent |
| C7 | Data-reset utility (wipe data, keep schema) | sentinel | C3 | Post-reset PRIV.1 green; schema intact |
| C8 | Durable OKG recall handler (query-time retrieval w/ provenance) | cortex+vox | C0 | C1 generalizes beyond regex keys; C2 stays 100% |

**Closure:** §2.8 (C0+C2+C3) · ws5-t1 (C1+C3+C4) · §2.12 (C5) · T3 latent (C6) · legacy (C7) · durable recall (C8).

## CANON
Std-3 isolation (candidates non-groundable until promoted), Std-3 ceiling (≤0.60 cap), Std-5 guardian asymmetry (promotion guardian-only), Std-2 provenance (CANDIDATE honest; promotion stamps GUARDIAN_APPROVED_INFERENCE), Std-1 (leaked noun staged visibly, not silently dropped; C6 removes a silent stub).
