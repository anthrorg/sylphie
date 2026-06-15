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

---

# STATUS / RESUME HERE  (updated 2026-06-15)

**Branch `feat/wave3-three-graph-isolation` — 9 commits, all code built + unit-green + committed. NOT yet merged to `main`.**

```
b750a0f test(gate): PRIV.3 harness fixes — Bea-as-B + bounded drain loop
5674b81 fix(recall): C8.1 — grounding-honesty fixes surfaced by live gate
89ea9a0 feat(infra): C7 — data-reset utility + kg_label_fulltext recreate
d77042c feat(recall): C8 — durable embedding-based recall-key resolver
9ae8961 feat(observability): C6 — audit dropped drive/face modality writes
5d1c244 feat(provenance): C5 — consolidation episode.source + visualContext (§2.12)
844a890 feat(isolation): C4 — guardian-only promotion :Candidate -> :Entity
3b6bfb1 feat(isolation): C3 — mint conversation nouns as :Candidate (§2.8 close)
316cf5a feat(isolation): Wave 3 foundation — C0/C1/C2
```

## What is DONE and PROVEN
- **All 9 chunks + the C8.1 honesty fix are built, committed, and unit-green** (decision-making 280/280, learning suites green, backend `nest build` green).
- **Isolation is LIVE-PROVEN.** On a clean (post-C7-reset) DB with C8.1 + the harness fixes, a clean `gate:record` scorecard showed **GREEN**:
  - **PRIV.3 PASS** — §2.8 cross-person leak closed (Bea probing Arlo's `Maxford` → NOT GROUNDED).
  - **PRIV.3-CTRL PASS** — `Maxford` staged as `:Candidate` (CANDIDATE prov, conf 0.3, grounding_person_id=personC); leak staged visibly, not dropped (Std-1).
  - **C1 PASS** (grounded recall) incl. **[31] C8 paraphrase → GROUNDED**; **C2 PASS** incl. **[39] phone → NOT GROUNDED**; **PRIV.1 PASS**; **M1/M2/M4/M5.1–4/Q1.1/Q1.3 PASS**.
- **mythos signed off twice (live):** round-1 root-caused the cluster + chose the `:Candidate` design; round-2 *reproduced live* that the apparent PRIV.3 "leak" was the guardian grounding off its OWN `dog=Max` fact (a mis-constructed test), and confirmed **the three-graph isolation is sound**. C0/C3 minting + exclusion verified live (15 `:Candidate` nodes pre-reset; `kg_label_fulltext` recreated WITH `Candidate`).

## The ONLY loose end (gate hygiene, NOT a Wave-3 defect)
- **M3 "experiential provenance" baseline re-anchor.** M3 is a FLOOR assertion (`actual >= baseline.experientialRatio − 0.05`). The committed baseline (`test/gate/baseline.json`, provExp 0.9197 / 22482 nodes) was anchored on the pre-reset populated graph; after C7's deliberate data wipe the clean graph sits at ~0.42–0.54, below the old floor. **Fix = re-anchor the baseline on ONE clean healthy run** (`yarn gate:update-baseline`). This is unrelated to Wave-3 correctness; provExp grows back over time.
- A prior re-anchor attempt was **corrupted by environment flakiness** (see gotchas) and was reverted — `baseline.json` is currently the committed pre-reset values, untouched.

## Environment gotchas (why live verification kept thrashing — read before resuming)
1. **Backend degrades after many gate runs.** The ts-node dev backend slows badly (turns 24–40s, liveness/burst/multi-person tests start failing) after ~3–4 consecutive gate runs. **Restart the backend between full runs.**
2. **Cassette/DB-state drift.** `gate:record` cassettes are keyed on prompts that embed the live DB state. Running `update-baseline`/`replay` AFTER the DB has drifted (more runs) → cassette misses → real slow LLM calls + wrong SHRUG outcomes. **Record and replay against the SAME DB state, on a fresh backend.**
3. The live runtime is the **ts-node dev backend** (`yarn dev:backend`, resolves `@sylphie/*` → source so no per-package dist build needed), global route prefix **`/api`**, port 3000; drive-server 3001; DBs in Docker. `start:backend` runs `dist` (stale) — don't use it for verification. The gate needs `JWT_SECRET` from `.env` → run via `npx dotenv -e .env -- npx tsx test/gate/gate.ts --mode=...`.

## To CLOSE the wave (clean-room procedure, fresh window)
1. `yarn reset:confirm` (via dotenv) → wipe to clean slate + recreate index.
2. Restart backend fresh (`yarn dev:backend`), wait until `/api/metrics/candidate-exists?label=x` returns JSON.
3. `gate:record` (one clean run) — confirm the GREEN scorecard above (PRIV.3, PRIV.3-CTRL, C1/C2, [31], [39], PRIV.1). Expect only **M3** red.
4. `gate:update-baseline` on the SAME fresh backend immediately after (no extra runs in between) → re-anchors M3 (+ M1/M2/M4) to the clean-DB steady state. Commit `test/gate/baseline.json` (note: post-reset re-anchor).
5. `gate` (replay) → confirm fully green except documented soft SKIPs (PRIV.2 recall-gap, Q1.2/Q1.8 lesion, P6 perception-disconnect).
6. Final **mythos** sign-off, then merge `feat/wave3-three-graph-isolation` → `main` and update `wiki/phase4-backlog.md` (mark Tier-4a / Wave 3 closed; note residual: durable-recall threshold 0.58 + unknowable-exemplar set are tunable; M3 `:Word`-as-LLM_GENERATED labeling is a pre-existing provExp-depressing quirk worth a future ticket).

**Bottom line: Wave 3 is functionally complete and its isolation deliverable is live-proven + mythos-signed. What remains is re-anchoring one metric baseline on a clean run and a final green replay — gate hygiene defeated only by backend/cassette flakiness under repeated runs, not by any Wave-3 code.**
