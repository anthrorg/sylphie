# WS3 — Compounding Memory: Build Plan

**Status:** ✅ CLOSED-WITH-RESIDUALS (2026-06-13) — Phases 0–2 (T1–T5) delivered + mythos-verified live. Phase 3 (multi-hop) deferred by design. Residuals: M2 baseline flakiness (pre-existing, not WS3), OTHER-instance decay deferred (stub §2.11), guardian-fact confidence-compounding is decay-resistance only (Std 3, by design). Live verdict: PASS-WITH-RESIDUALS; gate C3.1–C3.4 + C3PROV green, organic WKG-entity reinforcement fired live (retrieval_count 0→4).
**Governing doc:** `sylphie-tech-spec.md §9` (Six Immutable Standards), `§4.1` (graph isolation), `§3.3`/`§Confidence Dynamics` (ACT-R)
**Companion idea docs:** `wiki/ideas/grounded-okg-recall-retrieval.md`, `wiki/ideas/learning-pipeline-person-fact-wkg-leak.md`, `wiki/ideas/mood-congruent-episodic-retrieval.md`

> **Provenance note.** The first WS3 planning pass was produced by an agent that ran while Fable was down (suspected degraded model), so its conclusions were treated as UNVERIFIED. It was then independently checked by three reviewers (`atlas`, `canon`, `ashby`) against live code, and the plan below is the corrected synthesis grounded in that verification. Authored by the Opus 4.8 coordinator. `mythos` live-smoke remains mandatory before WS3 closes (CLAUDE.md).

---

## The thesis (code-confirmed)

**Memory compounds when retrieval-and-use reinforces knowledge confidence.** Today there are two separate confidence systems, and only one of them compounds:

1. **Procedure/action confidence** — `ConfidenceUpdaterService` (`packages/decision-making/src/confidence/confidence-updater.service.ts`) + `Type1TrackerService` (`.../graduation/type1-tracker.service.ts`). Has a real `reinforced` path: retrieval count, `lastRetrievalAt`, ACT-R recompute, Type-1 graduation/demotion. Keyed on **action/procedure node IDs**, driven by **action outcomes + prediction MAE**. This is the loop that moves the Type1/Type2 autonomy curve. Wired (for procedures).

2. **Knowledge/fact confidence** — WKG nodes/edges. These only ever **decay** with time (`ConfidenceDecayService`, `packages/learning/src/pipeline/confidence-decay.service.ts`) or get bumped **on re-extraction MERGE**. There is **no retrieval-reinforcement**. The decay service says so verbatim (`confidence-decay.service.ts:21-23`):
> *"The decay formula … uses the node's `updated_at` … in place of `lastRetrievalAt`, since retrieval counts are not yet tracked on nodes."*

**This is the compounding-memory broken edge, in the code's own words.** A fact Sylphie recalls and uses 100 times decays *identically* to one never touched. The ACT-R reinforcement machinery exists and works — but only on the *procedure* lane. Knowledge cannot compound through use because the use→reinforce edge for *facts* does not exist.

**WS3 closes the use→reinforce edge for knowledge**, and proves it with a metric that measures the loop. Multi-hop traversal / spreading activation is a **separate, deferred coverage feature** (Phase 3), NOT the curve-mover — see "What WS3 is NOT" below.

### Two coupled halves, both already half-built
- **Grounded retrieval that records *which* node grounded the answer** — extends the C1 `groundingProvenance` work (Std 4, Provenance Required). C1 already threads `groundingProvenance` (the deterministic `attr-${personId}-${key}` OKG node id) to `CycleResponse`.
- **A reinforcement path that bumps that node's confidence on successful use** — extends the ACT-R `reinforced` semantics to fact nodes, **capped at the 0.60 ceiling** (Std 3 — recall-use is *not* guardian confirmation, so it can strengthen toward 0.60 but never graduate past it: *"No node graduates from inference alone."*).

---

## What WS3 is NOT (corrected from the unverified first pass)

- **NOT "wire up spreading activation."** The four-layer engine at `packages/perception-service/cobeing/layer3_knowledge/spreading_activation.py` is **dead code** — orphaned, on a Python island the live TS cognition path never touches (confirmed by grep: its public symbols are referenced nowhere else; its only declared consumer, `definition_query.py:673 if request.activation_map:`, is always falsy). Flagged inert in stub inventory §2.9. Its four-layer design (budget / decay / inhibition / developmental depth) is a useful *reference spec* for Phase 3, nothing more.
- **NOT measured by the experiential-provenance ratio.** That ratio is a node-**creation** census (`test/gate/assertions.ts:126-155`). Spreading activation / retrieval is read-side and **cannot move it**. The first pass's stated fear rested on a category error. Keep the ratio as a *creation-honesty* metric; the compounding metric is the reinforcement-divergence in T4.
- **NOT gated on invented CANON.** The first pass cited a non-existent `wiki/CANON.md` and a "minimum-confidence-along-the-traversal-path" rule presented as existing law. There is no such standard. The governing doc is `sylphie-tech-spec.md §9`. The legitimate constraint is the **0.60 confidence ceiling (Std 3)** on reinforcing inference-grade fact nodes.

---

## Phase 0 — Honesty & baseline (cheap, first)

- **0.1** ✅ Flag the dead `spreading_activation.py` engine inert in `sylphie-stub-inventory.md` §2.9 (theater-prohibition hygiene).
- **0.2** ✅ Corrected CANON citations captured in this doc: governing doc `sylphie-tech-spec.md §9`; three-graph isolation is architectural (§4.1), not a numbered standard; confidence ceiling is **Std 3**. The "min-path-confidence" idea is dropped (re-file as a proposed constraint only if wanted).
- **0.3** Capture baselines (WS1 discipline) with the stack up: current recall grounding rate, and the proof-of-broken-edge as a measured number — confirm fact nodes carry no `retrieval_count` and decay regardless of use.

## Phase 1 — Close the knowledge use→reinforce edge (the curve-mover)

- **T1 — Grounded retrieval records the node id.** Extend C1's `groundingProvenance` into a real **pre-arbitration retrieval step** returning the WKG/OKG node id(s) that grounded the answer. Pre-arbitration (vs. a new ActionProcedure category) is the recommended home: it feeds both the procedure path and `deliberate()`, structurally closing the `seed-greet` bypass that forced C1's post-hoc regex upgrade. Single-hop is sufficient.
- **T2 — Knowledge reinforcement.** On a successful grounded recall-and-use, set `retrieval_count`/`lastRetrievalAt` on the used fact node and recompute its confidence via the ACT-R `reinforced` formula — **capped at 0.60 (Std 3)**.
  - *Architecture note:* fact confidence lives **on the Neo4j node**, whereas `ConfidenceUpdaterService` keeps an in-memory `Map` keyed by procedure id. So T2 is a **Neo4j-persisted reinforcement reusing `computeConfidence()` from `@sylphie/shared`**, NOT a call into the existing action-keyed service. Do **not** graft procedure Type-1 graduation onto facts.
- **T3 — Decay uses real retrieval.** Switch `ConfidenceDecayService` from the `updated_at` proxy to the now-tracked `lastRetrievalAt`/`retrieval_count` (its own comment flags this as the intended upgrade). Used knowledge becomes durable; unused fades. *This is the actual compounding dynamic.*

## Phase 2 — Prove it (correct metric, hermetic gate)

- **T4 — Compounding gate row (C3).** Teach a fact → recall-and-use N times → assert (a) `retrieval_count > 0` & `lastRetrievalAt` set on the used node; (b) its confidence diverges *upward* from a matched never-recalled control after a decay cycle; (c) it never exceeds 0.60. **Hermetic** — seed Neo4j in the harness (gate reproducibility discipline; do not depend on live-accumulated state).
- **T5 — Grounding provenance vs. live Neo4j** (the deferred C1 item, `ROADMAP.md:73`): a GROUNDED recall carries a node id; assert the node exists in WORLD. Hermetic-seeded.
- **T6 — Retire the metric misconception (docs).** Keep experiential-provenance ratio as a creation-honesty metric; the compounding metric is the T4 reinforcement-divergence. The creation census structurally cannot prove compounding.

## Phase 3 — Multi-hop recall coverage (DEFERRED, gated, optional)

Only after Phase 1–2 land and measure. Hard co-requisites before *any* wiring:
- **A.** WKG person-fact leak fix (stub §2.8) — per-hop provenance/person-scope gating; **atlas** owns. Multi-hop must not ship without it or it widens the §4.1 isolation breach. (Reviewer note: this is a co-requisite hard constraint — the per-hop confidence gate is the natural enforcement point — not necessarily a blocking predecessor, since the breach exists single-hop today.)
- **B.** Redesign the depth-advancement governor — servo on hub-adjusted activated-count, **not** raw spread ratio (which inverts meaning at scale because the budget clamps `activated` while `touched` explodes on hubs; ashby).
- **C.** Specify the priming↔inhibition coupling contract — the controlled query must return its traversed set so the negative-feedback (inhibition) arm has input. Wiring the amplifier without the governor is runaway-by-construction.
- Then: app-side BFS over **Cypher-side** confidence-gated single-hop queries (keeps latency in budget; app-side preserves per-hop decay/budget/scope that Cypher `[*1..n]` cannot). Acceptance: a genuine 2-hop inferential probe authored so only the seed is named (so the single-hop fallback cannot satisfy it).

---

## Decisions to lock before Phase 1 coding

1. **Reinforce fact confidence, capped at 0.60** (recall-use ≠ guardian confirmation) — confirm that reading of Std 3.
2. **Neo4j-persisted reinforcement reusing the ACT-R formula**, not the in-memory `ConfidenceUpdaterService` (which is action-keyed) — confirm the architecture.
3. **Multi-hop fully deferred to Phase 3** behind its three co-requisites — confirm.

**Coordinator default (proceeding unless corrected):** all three as recommended above.

## Sequencing & ownership

- The reframe **confirms WS3-is-next** (properly scoped, it *is* the curve-mover) → the stale `ROADMAP.md` "WS3/WS5 later" suggested-sequence note is corrected.
- T1/T2 are heavy multi-file decision-making changes → **`opus-agent`** implements once decisions are locked. T3/T4/T5 follow.
- Phase 3.A (leak fix) → **atlas**. Phase 3.B/C stability → **ashby**. Confidence-ceiling interaction → **canon**.
- `mythos` live-smoke mandatory before WS3 close.

## Verification corpus / files of record

- Confidence systems: `confidence-updater.service.ts`, `graduation/type1-tracker.service.ts`, `confidence-decay.service.ts` (the broken-edge comment at :21-23).
- Retrieval frontier: `packages/decision-making/src/wkg/wkg-context.service.ts` (`getContextForFrame` :150, `matchEntities` :619, single-hop `getRelationships` :675, unused `getSubgraph` :220).
- Grounding/C1: `wiki/ideas/grounded-okg-recall-retrieval.md`; `groundingProvenance` on `CycleResponse`.
- Dead engine: `packages/perception-service/cobeing/layer3_knowledge/spreading_activation.py`.
- Leak: stub §2.8; `packages/learning/src/pipeline/upsert-entities.service.ts:128`.
- Gate: `test/gate/{corpus.ts, assertions.ts, gate.ts}` (C1/C2 are single-fact-direct only today; no multi-hop probe exists).
