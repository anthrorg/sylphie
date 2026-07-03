# Sylphie Stub Inventory & Impact Analysis

**Date:** 2026-07-02 (regenerated) · **Baseline:** commit `228df73`
**Source:** full-repo bug audit — seven subsystem auditors reading source in full, all CRITICAL findings independently re-verified against source. Full detail: `docs/audits/repo-bug-audit-2026-07-02.md`. Feature-by-feature status: `sylphie-feature-inventory.md`.
**Supersedes:** the 2026-04-29 inventory (below the line). Several items it marked RESOLVED are re-opened here with evidence; several new theater/broken items were not previously enumerated.

Each entry: **what** (the gap), **where** (file:line), **why it matters** (behavioral impact), **complexity**. Ranked by severity — severity reflects the gap between architectural promise and runtime behavior, not effort to fix.

---

## TIER 0 — NEWLY FOUND, HIGHEST SEVERITY (2026-07-02)

### 0.1 Tensor cognition path is dead at the contract boundary
**Where:** `apps/sylphie/src/services/tensor-inference-adapter.service.ts:189-198` sends `drive_history` **flat** (120 floats); `packages/cognition-service/schemas.py:48` requires **nested** `list[list[float]]`.
**What:** Pydantic v2 cannot coerce `float → list[float]`, so **every `/cognition/cycle` call returns 422**. `runCycle` returns null, the breaker opens after 5, `last_cycle_result` stays None, categories never graduate, mode never advances. The service's `/health` still reports OK.
**Why it matters:** The entire learned-cognition frontier — the project's headline thesis — is inert. The previously-known "`per_category_confidence` always empty" symptom is *caused* by this (its aggregation code is real but unreachable). This is theater at the system level: healthy-looking service, dead core.
**Complexity:** Trivial (send nested; drop the `.flat()`). Add a contract test.

### 0.2 Drive-server WS client never reconnects
**Where:** `packages/drive-engine/src/ipc-channel/recovery.ts:118` (`attemptRecovery()` — zero production callers); `ws-channel.service.ts:106-141`; `drive-process-manager.service.ts:56-99`.
**What:** The `close` handler nulls the socket and stops. `RecoveryMechanism` is constructed and never used. The startup catch logs *"Drive Engine not available on startup — recovery will reconnect"* — false. `sendQueue` is unbounded with no TTL.
**Why it matters:** Any drive-server restart or network blip permanently severs the motivational system for the life of the main process, plus a slow memory leak. CANON's "isolated but connected" story quietly fails closed.
**Complexity:** Medium (wire `attemptRecovery` into the close/health path; wait for `open`; cap the queue).

### 0.3 Unauthenticated destructive endpoints
**Where:** `apps/sylphie/src/controllers/skills.controller.ts` (`POST /api/skills/reset` → wipes WORLD/SELF/OTHER + truncates `events`, `learned_patterns`, `voice_patterns`, `sensory_ticks`, `proposed_drive_rules` + resets drive state), `reset-world`; `metrics.controller.ts` (several `*-reset` + `c3-seed` + `decay-now`); `llm.controller.ts` (`POST /api/llm/lesion`); `graph.controller.ts` (full OKG read). Only `RulesController` + `AuthController.me` use `AuthGuard`.
**What:** Every listed route is anonymous-reachable; the only "protection" on reset is `{confirm:true}` in the body. CORS restrains browsers only.
**Why it matters:** In a public deployment (Railway + `ServeStaticModule`) a single anonymous `curl` permanently destroys all accumulated memory, or disables the LLM, or exfiltrates person facts.
**Complexity:** Low (apply `AuthGuard`, or gate to localhost/token/env-flag).

### 0.4 WKG dedup boost bypasses the 0.60 confidence ceiling
**Where:** `packages/decision-making/src/wkg/wkg-context.service.ts:823` — `const boosted = Math.min(1.0, existingConf + 0.05)`.
**What:** Every Type-2 deliberation whose `triggerContext` Jaccard-matches (>0.70) an existing procedure bumps its stored confidence +0.05, capped at **1.0** (not the Std-3 ceiling 0.60), with no guardian confirmation and no `computeConfidence()` (bespoke math — a Std-6 concern). Contrast `reinforceFactNode()` :740 which correctly clamps to 0.60.
**Why it matters:** Repeated similar inputs drive an unconfirmed INFERENCE procedure toward conf 1.0; with `W_CONFIDENCE=0.50` it then out-ranks everything — the documented runaway class (TK-104).
**Complexity:** Low (route through `computeConfidence`, clamp 0.60).

### 0.5 Pre-commit contradiction scanner is a structural no-op
**Where:** `packages/decision-making/src/arbitration/contradiction-scanner.service.ts:108` vs the only CONTRADICTS writer `packages/learning/src/pipeline/detect-contradictions.service.ts:151-169`.
**What:** Three independent mismatches: CONTRADICTS edges are only created between entity/candidate nodes (never ActionProcedures); the scanner matches `{id:$id}` but procedures carry `node_id`; and it reads `c.claim/c.existingFact/c.confidence` off the neighbouring **node** while the writer stores them on the **edge**.
**Why it matters:** The coherence gate ArbitrationService relies on to downgrade contradictory actions to SHRUG can never fire — every scan returns "clean." A safety gate presented as real that structurally cannot trigger.
**Complexity:** Medium (rewrite against the actual CONTRADICTS shape; add a fixture).

### 0.6 RLS half of drive isolation is unenforced and unverified
**Where:** `packages/drive-engine/src/postgres-verification/verify-rls.ts` (registered in no module → `OnModuleInit` never runs); `infra/postgres/init/001-runtime-user.sql:9-10` grants full DML to `sylphie_app` with no REVOKE/RLS policy on `drive_rules`.
**What:** The archived case study claims "verified by RlsVerificationService … startup ABORTS on failure." At runtime, nothing verifies and nothing restricts.
**Why it matters:** One of the two CANON pillars this subsystem is named for is presented as enforced but is façade. (The REVOKE gap is tracked as TK-AUDIT-1; the never-registered verifier is not.)
**Complexity:** Medium (register + pass the verifier; land the REVOKE + policy).

### 0.7 Frontend WS hooks: unmount-reconnect zombie sockets
**Where:** `frontend/src/hooks/useWebSocket.ts:366-375` (+170-183, 512-521), `useSupervisorWebSocket.ts:94-103`.
**What:** Cleanup clears the pending timer and calls `close()` but never nulls `wsRef` / sets an unmounted flag; the async `onclose` then passes its staleness guard and re-arms a reconnect that opens an orphan socket writing into the global store forever.
**Why it matters:** Re-creates the exact double-delivery bug the code comments claim was fixed — duplicate messages, double turn counts, and an orphan reconnect that can evict the visible tab (close 1012 suppresses its reconnect → permanently "disconnected").
**Complexity:** Low (one shared fix, applied to four hooks).

### 0.8 Fabricated face confidence disables enrollment
**Where:** `packages/perception-service/cobeing/layer2_perception/face_detector.py:256-258` (constant `self._config.confidence_threshold`, default 0.5); gated by `apps/sylphie/src/services/face-snapshot.service.ts:101,316` (`MIN_CONFIDENCE=0.65`).
**What:** Every face is reported at a constant fabricated 0.5 < 0.65, so `processFaceFrame` bails on every frame. No log, no error.
**Why it matters:** Face-snapshot enrollment never collects a single crop. A hardcoded value presented as model output that silently zeroes a downstream feature — the textbook theater case.
**Complexity:** Low (derive a real score from blendshape/detection score, or lower + log the gate).

### 0.9 Planning validation retry writes the wrong proposal
**Where:** `packages/planning/src/pipeline/constraint-validation.service.ts:120-172`, `planning.service.ts:582-586,649`.
**What:** `validate()` refines and re-validates internally but `ValidationResult` carries no proposal back; `executePipeline` never reassigns `currentProposal`, so on a pass at attempt ≥2 it creates the **original failing** proposal. Compounded by `refine()` zeroing `predictedDriveEffects` (`proposal.service.ts:107-130`) so refined expressive plans can never pass the theater check anyway.
**Why it matters:** A procedure that failed step-type/theater/tracing checks gets written under a `PLAN_VALIDATED` event — a quiet constraint-engine bypass.
**Complexity:** Low (return the refined proposal from `validate()`; repopulate drive effects on refine).

### 0.10 Concurrency holes in CycleGuard / self-ticks / Ollama
**Where:** `cycle-guard.service.ts:547-568`; `ollama-llm.service.ts:335,449`; `decision-tick-engine.service.ts:348-404`.
**What:** The zombie cycle's `finally` unconditionally frees the mutex and disarms the successor's watchdog (only the breaker is epoch-guarded). `client.chat()` has no timeout despite `chatTimeoutMs` being read and logged as active. Self-ticks bypass the watchdog entirely.
**Why it matters:** Under a slow/hung Ollama — the exact condition the guard exists for — turns are silently dropped, or a hung self-tick deadlocks all user turns until restart.
**Complexity:** Medium (epoch-guard the release; add a chat timeout signal; watchdog self-ticks).

---

## TIER 1 — Re-opened from the 2026-04-29 inventory (marked RESOLVED, verified NOT)

- **§Convergence "head removed" (was 2.5, RESOLVED):** the dead weights were removed, but `use_learned` can still flip true on one lucky random call after 1000 checks (`convergence.py:148-168`) — graduation of a **never-trained** head, persisted in the checkpoint. **THEATER, re-opened.**
- **§EWC "RESOLVED" (was 1.1):** the math is real, but the only consolidation trigger (`POST /cognition/phase-transition`) has **no runtime caller**, so EWC never activates in production; and even if called, `set_reference` runs before `compute_fisher` so the fresh Fisher is never used for its phase. **DEAD + ordering bug, re-opened.**
- **§per_category_confidence (was 2.3):** aggregation code now exists but is unreachable while every cycle 422s (see 0.1). **BROKEN by 0.1.**
- **§Contradiction/coherence assumptions:** the contradiction gate (0.5) was never enumerated as a stub; it is theater.

## TIER 2 — Confirmed still-open from the 2026-04-29 inventory

- **2.4 DeepSeek reasoning trace dropped** — `supervisor.service.ts:273-274`, still TODO. **STUB.**
- **4.3 One-shot voice transcribe empty** — `voice.controller.ts:32-36`, press-to-talk still returns empty. **STUB** (streaming path works).
- **3.3 DrivesController override/drift/reset** — honest 501s now (good); frontend affordances still render. **STUB (honest).**
- **2.9 Spreading-activation engine inert** — still ~1,090 lines, zero callers. **DEAD.**
- **3.1 Communication theater check flag-only** — `communication.service.ts` still returns `true`; and the drive-side enforcement it defers to is itself theater (0.6). **THEATER (both ends).**

## TIER 3 — Other verified live gaps (2026-07-02, see audit for full list)

Drive engine: baseline self-adjustment DEAD; HEALTH_STATUS fake; Timescale event pipeline DEAD (wrong columns); snapshot-staleness anchor lockout; SESSION_START state-injection; tick-drift math wrong.
WKG: `writeEntity` phantom node_id → dropped research edges; RELIEVES no-op (no `:Drive` nodes); `matchProcedures` property-name drift hides planned procedures; seeds minted at 0.60.
Learning: conversation speaker-facts stamped GUARDIAN/0.60 and attached to arbitrary subjects; transient-LLM-failure forfeits reflection; `markAsLearned` swallow → duplicate `:Conversation` nodes; rate-limited opportunities dropped without dead-letter.
Backend: TK-107 hardening incomplete (two more hang-capable inits + orphan-promise crash risk); `meanDriveResolutionTimes` SQL permanently broken; STT silent-death paths.
Frontend: word-rating sends into the void; perception WS never reconnects; dead metrics panels; Anthropic key in the bundle; transient auth failure logs the user out.

---

## NOTE ON STUB CULTURE (retained, still true — with a caveat)

The 2026-04-29 claim held that *"every stub sits behind a clean interface boundary … each stub is a known degraded mode, not a hidden bug."* That remains true of the **newest** paths (candidate staging, reinforcement, turn-taking, fail-closed validation — all real, wired, tested). It is **not** true of the older write/read plumbing and the resilience layer, where this audit found genuine hidden theater: success logged over no-op Cypher, verifiers never registered, reconnect that never reconnects, and confidence-ceiling escapes. The honest posture going forward: the interface discipline is real, but interface-honesty is not invocation-honesty — several clean interfaces front dead or lying implementations.

---

---

# ARCHIVE — 2026-04-29 inventory (retained for history; reconcile against Tier 0-3 above)

> The text below is the previous inventory. Where it says RESOLVED, cross-check Tier 1 — several resolutions did not hold at runtime as of 2026-07-02.

## TIER 1 — CRITICAL: Breaks an Architectural Promise

### 1.1 EWC catastrophic interference prevention — RESOLVED (2026-06-10)
[Historical: EWCRegularizer rewritten as Online EWC. NOTE 2026-07-02: real math, but never invoked in production — see Tier 1 above.]

### 1.2 Pressure-driven learning cycles — RESOLVED (2026-06-10)
[Historical: `forceCycle()` + `LearningPressureBridgeService`. Verified still holding 2026-07-02.]

### 1.3 Procedure conflict detection always passes — RESOLVED
[Historical: live conflict fetch + fail-closed + stable dedup key. Verified holding 2026-07-02, with the residual that the exact-match dedup + the +0.05→1.0 boost at write time (§0.4) reopen a confidence-ceiling escape on the same path.]

## TIER 2 — HIGH: Breaks a User-Visible Feature

### 2.1 Supervisor cognition control endpoints — RESOLVED (2026-06-10). Verified holding.
### 2.2 boost_salience — NOW RESOLVED (sidecar endpoint exists, `main.py:834-903`).
### 2.3 per_category_confidence — aggregation added; BROKEN by §0.1 (unreachable).
### 2.4 DeepSeek reasoning trace dropped — STILL OPEN (STUB).
### 2.5 ConvergenceModel — head removed, but THEATER re-opened (§Tier 1).
### 2.6 alwaysEvaluate types — guardian_feedback done; attractor_alert deferred.
### 2.7 Inference timeout — TS side has AbortSignal; sidecar-side asyncio guard still absent.
### 2.8 Learning person-fact WKG leak — SEALED (Wave-3 `:Candidate`); residue = GUARDIAN-provenance edges (§Tier 3).
### 2.9 Spreading-activation engine inert — STILL DEAD.
### 2.10 Post-hoc OKG recall regex — CLOSED (TK-84). Verified.
### 2.11 Fact reinforcement fields / decay — WORLD closed; OTHER deferred. Trigger gate rarely fires (see audit §1).
### 2.12 Visual episodes recall-only — deferred to WS5.5. Unchanged.

## TIER 3 — MEDIUM: Silent Degradation (2026-04-29)

### 3.1 Communication theater check flag-only — STILL OPEN (both ends theater).
### 3.2 SearXNG — CLOSED (TK-50). Verified live.
### 3.3 DrivesController stubs — now honest 501s. Frontend affordances remain.
### 3.4 Planning deferred branch — RESOLVED (live, load-bearing). Verified.

## TIER 4 — LOW (2026-04-29)

### 4.1 Perception streaming dead — RESOLVED (deleted).
### 4.2 DebugController legacy — trivial deletion, unchanged.
### 4.3 One-shot voice transcribe — STILL OPEN (press-to-talk broken).
