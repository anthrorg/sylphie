# Sylphie Stub Inventory & Impact Analysis

Date: 2026-04-29
Source: Direct code reading (no markdown-derived claims)
Companion to: `sylphie-architecture-notes.txt`

Each entry: **what** (the stub), **where** (file:line), **why it matters** (concrete behavioral impact), **fix complexity**.

Ranked by severity. Severity reflects gap between architectural promise and runtime behavior, not effort to fix.

---

## TIER 1 — CRITICAL: Breaks an Architectural Promise

### 1.1 EWC catastrophic interference prevention is a no-op

**Where:** `packages/cognition-service/training/replay.py:72-209`

**What:** `EWCRegularizer` exists as a class. `_compute_uniform_fisher` returns all-ones arrays — equivalent to plain L2 weight anchoring at the reference point. `set_reference()` is **never called anywhere in the codebase**. The trainer adds zero penalty gradients each step.

**Impact:**
- The cognition sidecar's whole "online learning + bootstrap progression" story rests on the claim that learning new action categories doesn't destroy older ones. EWC is the named mechanism for that.
- Currently, when the global model is trained on a new category, gradient descent freely overwrites weights that mattered for old categories. There is no protection.
- This is asymptomatic during shadow/audit (LLM still drives decisions) but becomes load-bearing in **partial** and **full** modes — the very modes the bootstrap progression is designed to reach.
- Concrete failure mode: a category that graduates early can silently regress as later training overwrites its weights. The shadow-mode agreement-rate gate would not detect this because graduated categories stop being compared.

**Fix complexity:** Medium-high. Needs a calibration dataset to compute true Fisher diagonals (TODO comment at `replay.py:92-93`), a hook to call `set_reference()` after each meaningful training milestone, and a tuning round on the lambda penalty.

---

### 1.2 Pressure-driven learning cycles do not exist

**Where:** `packages/learning/src/learning.service.ts:8-12, 89, 187`

**What:** Class docstring states explicitly: *"In a future phase, the Cognitive Awareness drive should trigger cycles when pressure exceeds a threshold. For now, the timer fires every CYCLE_INTERVAL_MS."* All four learning timers (60s consolidation, 5min reflection, 30min synthesis, 10min decay) are pure `setInterval`. Drive pressure has zero influence on cycle scheduling.

**Impact:**
- A core CANON claim is that learning is motivated — Sylphie consolidates because she *needs to*. Currently, learning is a cron job.
- High-CognitiveAwareness states (LLM cost pressure, novelty stress) should accelerate consolidation; they don't. Sylphie can sit on hours of unprocessed events with no urgency response, waiting for the next 60s tick.
- Conversely, low-pressure idle periods still run cycles, wasting work.
- This subtly invalidates the **InteroceptiveAccuracy** metric: Sylphie can't develop a real model of "I'm overwhelmed and should consolidate" if the consolidator ignores her drive state.

**Fix complexity:** Low. Add a CognitiveAwareness threshold check to `runMaintenanceCycle()` that bumps frequency when pressure > 0.7, and a `forceCycle()` entrypoint the drive engine can trigger via event.

---

### 1.3 Procedure conflict detection always passes

**Where:** `packages/planning/src/services/constraint-validation.service.ts:203-205`

**What:** `fetchExistingTriggerContexts()` returns `new Set<string>()` — a hard-coded empty set with a TODO to wire WKG. So `checkProcedureConflict` (one of the five constraint checks) always passes.

**Impact:**
- Planning can write duplicate `:ActionProcedure` nodes with overlapping `trigger_context` values. The action-retriever's composite scoring will then return both with similar scores, creating non-deterministic Type 1 selections.
- Worse, guardian-taught procedures (TAUGHT_PROCEDURE provenance, conf 0.50) will silently coexist with INFERENCE-provenance duplicates of the same behavior, fragmenting the confidence updates across two nodes.
- Over time this manifests as "Sylphie sometimes does X correctly, sometimes does X incorrectly, with no apparent learning" — because half her experience is being attributed to a phantom twin procedure.

**Fix complexity:** Low. One Cypher query against Neo4j WORLD: `MATCH (p:ActionProcedure) RETURN p.trigger_context AS ctx`.

---

## TIER 2 — HIGH: Breaks a User-Visible Feature

### 2.1 Supervisor cannot actually intervene on the cognition sidecar

**Where:** `packages/cognition-service/main.py:448-491`

**What:** Three control endpoints are TODO stubs:
- `POST /cognition/control/reinforce` — comment "Not yet implemented", logs and returns OK
- `POST /cognition/control/correct` — same
- `POST /cognition/control/freeze` / `/unfreeze` — same

The frontend Guardian view + Supervisor service both call these.

**Impact:**
- The supervisor's entire "corrective training signal" story is theatre. When DeepSeek flags a wrong arbitration and the supervisor calls `executeIntervention({type:'correct', ...})`, the HTTP call succeeds, the intervention is logged, and the sidecar does nothing.
- The guardian dashboard's "rollback to checkpoint" button works (rollback IS implemented at `main.py:494-511`) but the more granular reinforce/correct/freeze controls are silently inert.
- This makes it impossible to distinguish "the supervisor is making the system better" from "the supervisor is just emitting verdicts that get logged" — the very question CANON's Guardian Asymmetry section depends on.

**Fix complexity:** Medium. Each endpoint needs a defined gradient-injection or weight-mask operation on the global model. `freeze` is the easiest (set a per-parameter requires_grad flag); `reinforce` and `correct` need policy decisions about how supervisor signals enter the loss.

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

### 2.5 ConvergenceModel never uses its learned head

**Where:** `packages/cognition-service/models/convergence.py:70, 124-129`

**What:** `use_learned: bool` flag defaults False. The heuristic path is pure cosine-similarity averaged across panels. There is **no code path anywhere that flips `use_learned` to True** — same trapdoor as EWC.

**Impact:**
- The 10K-parameter learned convergence model sits in memory, gets serialized to disk on checkpoints, but never influences a single decision.
- Bootstrap progression `partial → full` requires "≥ 3 graduated categories AND overall agreement ≥ 0.90" — the agreement signal *should* improve as the convergence model learns when panels disagree meaningfully vs trivially. Without learned convergence, agreement is just averaged cosine similarity, which has a much noisier ceiling.
- Practically: bootstrap may stall at partial mode because raw cosine averaging is too noisy to clear the 0.90 threshold consistently.

**Fix complexity:** Medium. Need a defined supervisor signal or self-supervised target for the convergence head, plus the flip-trigger logic (probably "after the panel models have trained N steps").

---

### 2.6 `alwaysEvaluate` event types are not wired

**Where:** `packages/supervisor/src/supervisor.service.ts:229-230`

**What:** `SamplingPolicy.alwaysEvaluate` defaults to `['guardian_feedback', 'attractor_alert']`, type union also includes `model_freeze` / `model_rollback`. `shouldEvaluate()` only checks `cycleCount % sampleRate === 0` — the alwaysEvaluate logic is never consulted. TODO comment.

**Impact:**
- Guardian feedback events should trigger an immediate supervisor evaluation regardless of sample rate. They don't.
- Attractor alerts (e.g., DepressiveAttractor triggered, Type2Addict detected) should also force evaluation. They don't.
- The supervisor thus misses the most important moments to be watching — exactly when human-equivalent oversight would be most valuable.

**Fix complexity:** Low. Subscribe to the event backbone for these specific event types and bypass the sampling gate when seen.

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
- BUT — the operator can't tell. There's no error, no indicator that the UI lever is decorative. Every guardian who tries them assumes they worked.

**Fix complexity:** Either (a) remove the UI affordances, or (b) route the override through a permitted path (e.g., guardian feedback events that the drive-engine processes). The current state — UI controls that silently do nothing — is the worst outcome.

---

### 3.4 `validationResult.deferred` branch in Planning is unreachable

**Where:** `packages/planning/src/services/constraint-validation.service.ts:192`, `packages/planning/src/planning.service.ts:551-556`

**What:** ConstraintValidationService always sets `deferred: false` since it became deterministic (no LLM). The `if (validationResult.deferred)` re-enqueue path in PlanningService is dead code.

**Impact:**
- Low-impact dead code. Planning works correctly today.
- BUT — if ConstraintValidationService is ever upgraded to add LLM-based checks back (e.g., semantic conflict detection), the dead `deferred` path will silently activate without testing, because no current test exercises it.

**Fix complexity:** Trivial. Either delete the branch or document that it's a forward-compat hook with explicit test coverage.

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
| 1.1 | EWC catastrophic interference | CRITICAL | Med-High | No (silent regression) |
| 1.2 | Pressure-driven learning cycles | CRITICAL | Low | No (latency only) |
| 1.3 | Procedure conflict detection | CRITICAL | Low | Yes (non-deterministic Type 1) |
| 2.1 | Cognition control endpoints | HIGH | Medium | Yes (supervisor inert) |
| 2.2 | boost_salience intervention | HIGH | Medium | Partial |
| 2.3 | per_category_confidence | HIGH | Low | Yes (empty dashboard panel) |
| 2.4 | DeepSeek reasoning trace dropped | HIGH | Trivial | Yes (audit blindness) |
| 2.5 | ConvergenceModel.use_learned | HIGH | Medium | No (bootstrap stall risk) |
| 2.6 | alwaysEvaluate types | HIGH | Low | No (sampling miss) |
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
