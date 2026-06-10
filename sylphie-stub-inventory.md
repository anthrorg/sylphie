# Sylphie Stub Inventory & Impact Analysis

Date: 2026-04-29
Source: Direct code reading (no markdown-derived claims)
Companion to: `archive/sylphie-architecture-notes.txt`, `sylphie-assessment.md`

Each entry: **what** (the stub), **where** (file:line), **why it matters** (concrete behavioral impact), **fix complexity**.

Ranked by severity. Severity reflects gap between architectural promise and runtime behavior, not effort to fix.

---

## TIER 1 — CRITICAL: Breaks an Architectural Promise

### 1.1 EWC catastrophic interference prevention — RESOLVED (2026-06-10)

**Where (was):** `packages/cognition-service/training/replay.py`

**Resolution:** `EWCRegularizer` rewritten as Online EWC (Schwarz 2018). `compute_fisher()` computes empirical Fisher diagonal (squared gradients, normalized, floored at 1e-8, clamped at 1e2 per-layer). `set_reference()` implements `F_new = 0.7·F_old + F_phase`. λ ramp-up over 200 steps prevents Adam-momentum shock. Per-layer Fisher stats logged at every phase transition (Fisher collapse is silent without this). `DataBuffer.snapshot_calibration()` added. `POST /cognition/phase-transition` endpoint triggers `set_reference()` + `compute_fisher()` at runtime when bootstrap phase changes. 7 tests in `training/tests/test_replay.py`, all passing.

---

### 1.2 Pressure-driven learning cycles — RESOLVED (2026-06-10)

**Where (was):** `packages/learning/src/learning.service.ts:8-12, 89, 187`

**What (was):** Timer-only triggers; CognitiveAwareness pressure had zero influence on cycle scheduling.

**Resolution:** `LearningService.forceCycle()` added (`ILearningService` contract + implementation). `LearningPressureBridgeService` in `apps/sylphie/src/services/learning-pressure-bridge.service.ts` subscribes to `driveState$`, and calls `forceCycle()` when `CognitiveAwareness > 0.70` (30s minimum interval between pressure-triggered cycles). Timer remains as a safety floor at 60s. Bridge registered in `AppModule`.

---

### 1.3 Procedure conflict detection always passes — RESOLVED

**Where:** `packages/planning/src/pipeline/constraint-validation.service.ts`, `constraint-checks.ts`, `proposal.service.ts`, `procedure-creation.service.ts`

**What (was):** `fetchExistingTriggerContexts()` returned a hard-coded empty set, so `checkProcedureConflict` always passed and Planning could write duplicate `:ActionProcedure` nodes with overlapping `trigger_context`, fragmenting confidence across phantom-twin nodes and corrupting Type 1 graduation.

**Resolution (two halves):**
- **Live conflict fetch + fail-closed.** `fetchExistingTriggerContexts()` now queries Neo4j WORLD for existing `trigger_context` values. On query error it returns a discriminated `{ ok: false }` and `validate()` returns `deferred: true` (see §3.4) — fail CLOSED, never blind-pass.
- **Stable dedup key for ALL proposal paths.** The exact-match dedup only worked for the template path (which used the deterministic `contextFingerprint`). The LLM path authored a free-form trigger string, so two proposals for the same pattern never collided. `ProposalService.withStableTrigger()` now pins `triggerContext` to `opportunity.payload.contextFingerprint` for every path (template, LLM, refinement, parse-fallback), and preserves any LLM-authored descriptive text in a separate `triggerDescription` property (`trigger_description` on the node). Decision Making retrieves by Jaccard similarity against the same fingerprint format, so retrieval semantics are unchanged. Empty/whitespace triggers can no longer poison the dedup set: `checkProcedureConflict` abstains on them, and the override means `''` never reaches the graph as a key. CANON: each guardian teaching carries a distinct `contextFingerprint`, so distinct teachings still get distinct keys.

**KNOWN LIMITATION (flagged):** Dedup is still exact-match on the stable key. It closes the common case (same opportunity / same pattern → same fingerprint → caught). It does NOT catch semantic near-duplicates — two genuinely different opportunities whose `contextFingerprint`s differ but describe the same underlying behavior. True semantic/fuzzy dedup at write time would require the embedding service and is out of planning-local scope. (Note: Decision Making's own `wkg-context.service.ts:writeActionProcedure` DOES do Jaccard>0.70 fuzzy dedup on its write path; Planning's write path does not, by design, to keep validation synchronous and I/O-light.)

---

## TIER 2 — HIGH: Breaks a User-Visible Feature

### 2.1 Supervisor cognition control endpoints — RESOLVED (2026-06-10)

**Where (was):** `packages/cognition-service/main.py`

**Resolution:** All four endpoints now do real work:
- `reinforce` — injects `round(strengthFactor*3)` clamped [1,10] copies of the input sample into DataBuffer; DataBuffer.add_sample() added.
- `correct` — injects `(inputVector, correctCategory)` 3× into DataBuffer; calls `zero_pending_for_category()` on the trainer (logs + no-op hook wired).
- `freeze` / `unfreeze` — flip `trainer._training_frozen`; `_train_step()` returns early when frozen.
- `boost_salience` (TypeScript sidecar-control.service.ts) deferred — needs per-feature attention multipliers on panel models (WS3).

---

### 2.2 `boost_salience` intervention is unimplemented

**Where:** `packages/supervisor/src/sidecar-control.service.ts:92-97`

**What:** Comment: *"Not yet implemented on sidecar — log and acknowledge."* Returns OK without making any HTTP call.

**Impact:**
- One of the six SupervisorIntervention types is permanently inert. Anywhere code paths conditional on this type assume effect, the assumption is wrong.
- Practical effect: the supervisor cannot tell the cognition sidecar "pay more attention to drive history when this pattern recurs" — the lever doesn't exist.

**Fix complexity:** Medium. Requires both a sidecar endpoint and a defined "salience pattern" semantics on the panel models (probably a per-feature attention multiplier).

---

### 2.3 `per_category_confidence` is always empty in metrics

**Where:** `packages/cognition-service/main.py:148, 387-397`

**What:** `_state.per_category_confidence: dict[str, float]` initialized empty, **never written** by trainer or cycle code. Surfaced via `GET /cognition/metrics`.

**Impact:**
- The Guardian dashboard's "Per-Category Confidence" panel renders empty — no per-category trust signal visible.
- More subtly: the `agreement_rate` from BootstrapTracker is the only category-level signal flowing to the operator. Confidence and agreement are different things; without confidence, the operator cannot tell if a category that's at "85% agreement, ready to graduate" is also internally confident.
- Causes operator misjudgment about which categories to allow into partial/full mode.

**Fix complexity:** Low. The panel models already produce per-cycle confidence scalars (`panel_models.py:114-116`). A short hook in `_train_step` or `cycle.run` to aggregate by `action_category` would populate it.

---

### 2.4 DeepSeek reasoning trace is dropped

**Where:** `packages/supervisor/src/supervisor.service.ts:273-274`

**What:** `SupervisorVerdict.reasoningTrace?` is in the type signature, but always set to `undefined`. TODO comment at line 273-274.

**Impact:**
- DeepSeek-reasoner returns a `reasoning_content` field with the chain-of-thought used to reach the verdict — the entire reason for choosing DeepSeek over Sonnet/Haiku.
- Discarding it means we pay for reasoning tokens (priced separately at $0.42/M output) but never see the reasoning.
- Operator cannot distinguish "supervisor flagged this because it's genuinely wrong" from "supervisor flagged this because of a shallow heuristic match" — exactly the audit signal the supervisor is supposed to provide.

**Fix complexity:** Trivial. Plumb `response.metadata?.reasoningContent` through `OllamaLlmService` (likely also missing there) → `LlmResponse` → `parseVerdict` → `SupervisorVerdict.reasoningTrace`.

---

### 2.5 ConvergenceModel dead panel-adjustment head — RESOLVED (2026-06-10)

**Where (was):** `packages/cognition-service/models/convergence.py`

**Resolution:** Dead `w_adj`/`b_adj` weights removed from `_build()`, `save()`, `load()`. `total_params` now accurately reports 10369. Legacy checkpoints with `w_adj`/`b_adj` keys are silently ignored in `load()` (backward compat). `_predict_learned()` has an explicit TODO: graduation criterion requires `>= N convergence training pairs + validation accuracy threshold`. `use_learned` remains False until that criterion is met.

---

### 2.6 `alwaysEvaluate` event types — PARTIALLY RESOLVED (2026-06-10)

**Where (was):** `packages/supervisor/src/supervisor.service.ts:229-230`

**Resolution (guardian_feedback half):** `CycleResponse.inputCategory` field added (`packages/shared/src/types/communication.types.ts`). Threaded from `processInputResult.inputCategory` in `decision-making.service.ts`. `shouldEvaluate()` now returns `true` when `cycle.inputCategory === 'GUARDIAN_FEEDBACK'` and it's in the `alwaysEvaluate` list.

**Remaining (attractor_alert half):** `attractor_alert` cannot be detected from `CycleResponse` yet — requires the attractor monitor to emit a per-cycle marker on the CycleResponse. Deferred until attractor monitor emits this signal.

---

### 2.7 `MAX_INFERENCE_TIMEOUT_MS = 50` is not enforced

**Where:** `packages/cognition-service/config.py:34`

**What:** Constant defined, but no watchdog around `cycle.run`.

**Impact:**
- The TS-side `CognitionGatewayService` has its own 50ms timeout (`AbortSignal.timeout(50)` at `cognition-gateway.service.ts:174`), so a slow sidecar doesn't block the decision loop. But a hung sidecar means subsequent cycles silently skip tensor inference until reconnect.
- If the sidecar enters a slow-path (e.g., a panel model with degenerate weights), the operator sees "tensor inference unavailable" with no internal sidecar diagnostic of why.

**Fix complexity:** Trivial. Wrap the cycle in `asyncio.wait_for(...)`.

---

## TIER 3 — MEDIUM: Silent Degradation

### 3.1 CommunicationService theater check is flag-only

**Where:** `apps/sylphie/src/services/communication.service.ts:778-794` (`checkTheaterProhibition`)

**What:** Logs a debug warning when anxiety > 0.7 + non-empty text, but always returns `true` (grounded). Comment: *"TODO: Implement real theater validation — compare response sentiment against drive state."*

**Impact:**
- **Lower than it looks** because the drive-engine has its own enforcement: ActionOutcomePayload requires a `theaterCheck` field, and `applyOutcome` returns early with zero reinforcement when `isTheatrical=true`.
- BUT — the theaterCheck field that arrives at the drive-engine is computed by callers, not by Communication. If callers send `isTheatrical: false` while Sylphie is in fact saying something incongruent with her state, no enforcement fires.
- The real gap: there is no service that does sentiment-vs-drive correlation analysis on the response text. So `isTheatrical` is essentially never set to true in the current call sites.

**Fix complexity:** High. Needs sentiment analysis (or a small classifier) that maps response text to expected drive correlates.

---

### 3.2 SearXNG container runs but no code uses it

**Where:** `docker-compose.yml:172-186`, `packages/learning/src/services/research.service.ts:53-188`

**What:** SearXNG container is configured and exposed on port 8888. `ollamaConfig.searxngUrl` is registered. ResearchService runs three SQL queries against TimescaleDB and that's it — no HTTP fetch to SearXNG anywhere.

**Impact:**
- Planning's "research" step that informs proposal generation is purely retrospective (look at past events with similar fingerprints). It can't actually research anything new.
- Architectural promise: when an opportunity has insufficient historical data, fall back to web research. Currently: when data is insufficient, return `sufficient: false` and fail the proposal.
- For GuardianTeaching opportunities specifically (sufficiency threshold 0), this isn't fatal — the guardian's instruction text *is* the research. For other classifications, it bottlenecks.

**Fix complexity:** Medium. Add a SearXNG client to ResearchService, define how web results are merged into `extractPatterns()` output, decide on rate limits.

---

### 3.3 Frontend DrivesController endpoints are stubs

**Where:** `apps/sylphie/src/controllers/drives.controller.ts:11-24`

**What:** `POST /api/drives/override`, `/drift`, `/reset` all return `{}` immediately. The DrivesPanel UI in `frontend/src/components/DrivesPanel.tsx` calls them with debounced 300ms POSTs.

**Impact:**
- Guardian dashboard's drive override switches and drift sliders **do nothing**. The frontend updates its local state, the API succeeds, the drive engine is unaffected.
- This is a real CANON tension: drive isolation says the main app cannot mutate drive state. So these stubs may be **correctly stubs** — they pretend to be a control surface but the drive-engine ignores them by design.

**Partial resolution (2026-06-09):** the three POST routes now throw `NotImplementedException` (HTTP 501) with a CANON Drive-Isolation explanation instead of returning a fake `{}` success. The "silent UI lie" — the worst outcome — is gone: a caller now gets a truthful error. The frontend DrivesPanel still needs follow-up (option (a) below) so guardians don't see 501s on decorative controls.

**Fix complexity:** Remaining work is a product decision: either (a) remove the UI affordances, or (b) route the override through a permitted path (e.g., guardian feedback events that the drive-engine processes). The backend no longer misrepresents success.

---

### 3.4 `validationResult.deferred` branch in Planning is unreachable — RESOLVED

**Where:** `packages/planning/src/pipeline/constraint-validation.service.ts`, `packages/planning/src/planning.service.ts`

**What (was):** ConstraintValidationService always set `deferred: false` since it became deterministic, leaving the `if (validationResult.deferred)` re-enqueue path in PlanningService as dead code.

**Resolution:** The `deferred` path is now LIVE and load-bearing. When the procedure-conflict check cannot fetch existing trigger contexts from the WORLD graph (Neo4j unreachable), `validate()` returns `deferred: true` instead of silently passing with an empty set. This is the fail-closed half of the §1.3 fix: a transient DB blip now re-enqueues the opportunity rather than writing a possibly-duplicate procedure. PlanningService re-enqueues deferred opportunities up to `MAX_DEFERRALS` (5) times, then drops loudly (`OPPORTUNITY_DROPPED`, error log) so a permanent outage cannot spin forever. The degradation is logged at error level and emits a `PLAN_VALIDATION_FAILED` event with `reason: 'world_unreachable_conflict_check_skipped'`.

---

## TIER 4 — LOW: Already-Handled or Cosmetic

### 4.1 Perception streaming endpoints are dead code

**Where:** `packages/perception-service/main.py:1053-1071, 1086-1091`

**What:** `/perception/stream` and `/stream/raw` are defined but `_state.debug_frame_store` is never populated since the camera pipeline path is `# No camera pipeline — frames come from the browser via NestJS` (`main.py:181-183`). Always returns 503.

**Impact:**
- Pure dead code from the pre-browser-camera era. No live consumer.
- Confuses anyone doing endpoint discovery.

**Fix complexity:** Trivial. Delete the routes.

---

### 4.2 DebugController is legacy stub

**Where:** `apps/sylphie/src/controllers/debug.controller.ts`

**What:** `/debug/camera/status` returns `{active:false}`, `/debug/camera/stream` returns 404.

**Impact:** Pre-browser-camera compat. Nothing currently calls these.

**Fix complexity:** Trivial deletion.

---

### 4.3 VoiceController.transcribe one-shot endpoint is empty

**Where:** `apps/sylphie/src/controllers/voice.controller.ts:32-36`

**What:** Returns `{text:'', confidence:0, latencyMs:0}`. Comment notes the real path is `/ws/audio` Deepgram streaming.

**Impact:**
- `useVoiceRecording.ts` (the press-to-talk component) POSTs to this endpoint. It always gets empty text back, never recognizes any speech.
- The streaming path (`useAudioStream` + `/ws/audio`) is the actual working voice input.
- Net: **press-to-talk is broken**, hold-to-talk via streaming works. Operator-visible inconsistency.

**Fix complexity:** Low. Either implement one-shot via Deepgram REST API or remove the press-to-talk UI affordance.

---

## SUMMARY TABLE

| # | Stub | Tier | Fix Effort | User-Visible? |
|---|------|------|------------|---------------|
| 1.1 | EWC catastrophic interference | CRITICAL | ✅ DONE | No (silent regression) |
| 1.2 | Pressure-driven learning cycles | CRITICAL | ✅ DONE | No (latency only) |
| 1.3 | Procedure conflict detection | CRITICAL | Low | Yes (non-deterministic Type 1) |
| 2.1 | Cognition control endpoints | HIGH | ✅ DONE | Yes (supervisor inert) |
| 2.2 | boost_salience intervention | HIGH | Medium | Partial |
| 2.3 | per_category_confidence | HIGH | Low | Yes (empty dashboard panel) |
| 2.4 | DeepSeek reasoning trace dropped | HIGH | Trivial | Yes (audit blindness) |
| 2.5 | ConvergenceModel.use_learned | HIGH | ✅ DONE (head removed) | No (bootstrap stall risk) |
| 2.6 | alwaysEvaluate types | HIGH | ✅ PARTIAL (guardian_feedback done, attractor_alert deferred) | No (sampling miss) |
| 2.7 | Inference timeout enforcement | HIGH | Trivial | No (hang risk) |
| 3.1 | Theater check sentiment-vs-drive | MEDIUM | High | No (toothless guard) |
| 3.2 | SearXNG unused | MEDIUM | Medium | No (research limited to history) |
| 3.3 | DrivesController stubs | MEDIUM | Trivial (delete) | Yes (UI lies) |
| 3.4 | Planning deferred branch dead | MEDIUM | Trivial | No |
| 4.1 | Perception streaming dead | LOW | Trivial (delete) | No |
| 4.2 | DebugController legacy | LOW | Trivial (delete) | No |
| 4.3 | One-shot voice transcribe | LOW | Low | Yes (press-to-talk broken) |

---

## RECOMMENDED ORDER OF ATTACK

**Phase A (immediate, before any partial-mode bootstrap):**
- 1.1 EWC — without this, partial mode is unsafe
- 1.3 Procedure conflict — actively corrupting Type 1 graduation now
- 2.4 DeepSeek reasoning trace — paying for it, throwing it away

**Phase B (next sprint):**
- 1.2 Pressure-driven learning
- 2.3 per_category_confidence (cheap win, big observability gain)
- 2.6 alwaysEvaluate wiring
- 2.7 Inference timeout

**Phase C (when supervisor work resumes):**
- 2.1 Control endpoints (reinforce/correct/freeze)
- 2.5 ConvergenceModel.use_learned
- 2.2 boost_salience

**Phase D (cleanup):**
- 3.3 DrivesController — pick one resolution
- 4.3 Voice one-shot — pick one resolution
- 4.1, 4.2, 3.4 — delete dead code

**Deferred (architectural decision needed):**
- 3.1 Theater check sentiment analysis
- 3.2 SearXNG integration

---

## NOTE ON STUB CULTURE

The pattern is consistent across the codebase: **every stub sits behind a clean interface boundary.** Type contracts are honored even where implementations are empty. Provenance fields, drive snapshots, theaterCheck records, and event-boundary maps are populated correctly even when the consumers of those values are stubs.

This is a deliberate Lesion Test discipline — each stub is a known degraded mode, not a hidden bug. The honest case-study claim is:

> *"The type system encodes the full architecture. ~80% of the cognitive loop is wired end-to-end. The remaining 20% routes through stable interfaces and is identifiable, named, and enumerable."*

This document is that enumeration.
