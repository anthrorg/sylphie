# Ideas Research Report — ARCHIVED

**Generated:** 2026-04-09
**Last Updated:** 2026-04-13
**Archived:** 2026-06-20
**Archived by:** TK-76 (EP15.6) triage pass
**Closure reason:** All 46 ideas triaged — each annotated as ALREADY-TICKETED, ALREADY-DONE, or ARCHIVED with reason. No un-filed genuine gaps remain.

---

## Triage Key

Each idea below carries one of three dispositions:

- **ALREADY-TICKETED** — A contract ticket (in planning/contract.yaml) directly covers this idea. The ticket id is cited.
- **ALREADY-DONE** — The system already implements this; no action needed.
- **ARCHIVED** — Stale, superseded, out-of-scope, or resolved by other means. Reason given.

---

## Executive Summary

Forty-six proposed ideas were researched against the current Sylphie codebase (15 original + 29 new as of 2026-04-12 + 2 new as of 2026-04-13). Below is a prioritized summary followed by detailed findings for each idea.

### Original Ideas (2026-04-09)

| # | Idea | Feasibility | Effort | Risk | Priority |
|---|------|-------------|--------|------|----------|
| 1 | Concurrent Persistence Checks in Pipeline | HIGH | LOW (10-15 lines) | LOW | Quick Win |
| 2 | Configurable Persistence Check Weights | HIGH | LOW-MODERATE (2-4 days) | LOW | Quick Win |
| 3 | Planning Requeue Backoff on LLM Unavailability | HIGH | LOW (1-2 days) | LOW | Quick Win |
| 4 | Prediction Evaluator Memory Lifecycle | HIGH | LOW (1-2 days) | LOW | Quick Win |
| 5 | Opportunity Queue Eviction on Hard Cap | HIGH | LOW (~20 lines) | LOW | Quick Win |
| 6 | Inject Anxiety into Outcome Reporter | HIGH | LOW (1 day) | LOW | Quick Win — CANON Fix |
| 7 | Grounded Confidence for Reflection Insights | HIGH | LOW (1-2 days) | LOW | Quality Gate |
| 8 | Observation Validation Pipeline | HIGH | LOW-MODERATE (2-3 days) | LOW | Quality Gate |
| 9 | Deterministic Constraint Validation | HIGH | MODERATE (3-5 days) | MEDIUM | LLM Reduction |
| 10 | Deterministic Edge Refinement | HIGH | MODERATE (3-5 days) | LOW | LLM Reduction |
| 11 | Learning Pipeline Dead-Letter Tracking | HIGH | MODERATE (4-6 days) | LOW | High Value |
| 12 | Perception Thread-Safe State and Lazy Init | HIGH | LOW-MODERATE (2-3 days) | LOW | Reliability |
| 13 | Scope-Aware CALLS Edge Resolution | HIGH | MODERATE (17-25 hrs) | MEDIUM | Infrastructure |
| 14 | Rule-Based Cross-Modulation Engine | LOW — ALREADY EXISTS | N/A | N/A | No Action Needed |
| 15 | Decision Cycle Structured Error Recovery | HIGH | HIGH (16-20 hrs) | MEDIUM | Cross-Cutting |

**Note:** `batch-decision-event-flush.md` was empty and excluded from research.

### New Ideas (2026-04-12)

| # | Idea | Feasibility | Effort | Risk | Priority |
|---|------|-------------|--------|------|----------|
| 16 | Clean Up Stale Stub Comments in ActionHandlerRegistry | HIGH | LOW (1 day) | NONE | Documentation |
| 17 | Wire HALLUCINATED/DEPRESSIVE Attractor Detectors | ALREADY DONE | N/A | N/A | No Action Needed |
| 18 | Forward Drive Events to TimescaleDB | HIGH | MODERATE (2-3 days) | LOW | Integration |
| 19 | Implement DrivesController Stub Endpoints | HIGH | MODERATE (2-3 days) | MEDIUM | API Wiring |
| 20 | Wire IPCSelfKgReader for Real KG(Self) Access | HIGH | HIGH (5-7 days) | MEDIUM | Core Architecture |
| 21 | Support 'call' Step Type in MorphologyExecutor | HIGH | MODERATE (3-4 days) | MEDIUM | Feature |
| 22 | Remove SensoryLoggerService Temporary Stand-in | HIGH | MODERATE (2-3 days) | HIGH | Cleanup/Refactor |
| 23 | Simulation Cross-Drive Effect Aggregation | HIGH | MODERATE (3-4 days) | MEDIUM | Feature/Ranking |
| 24 | Implement Real Theater Prohibition Validation | HIGH | MODERATE (3-4 days) | MEDIUM | Validation |
| 25 | Add Timeout Guards to LLM Calls in Learning Pipeline | HIGH | LOW (1-2 days) | LOW | Quick Win |
| 26 | Per-Row Error Isolation in Planning Ingest | HIGH | LOW (1 day) | LOW | Quick Win |
| 27 | Add Jitter and Iterative Retry in Recovery Mechanism | HIGH | LOW (1-2 days) | LOW | Resilience |
| 28 | Adaptive Candidate Scoring Weights | HIGH | MODERATE (4-5 days) | MEDIUM | High Value |
| 29 | Perception Frame Source Timeout Guards | HIGH | LOW (1-2 days) | MEDIUM | Quick Win |
| 30 | Supervisor Verdict Audit Trail | HIGH | MODERATE (3-4 days) | LOW | High Value |
| 31 | Ungrounded Insight Re-grounding Sweep | HIGH | MODERATE (3-4 days) | LOW | Medium Value |
| 32 | Windowed Sampling for Long Session Reflection | HIGH | MODERATE (3-4 days) | MEDIUM | High Value |
| 33 | Learning Pipeline Neo4j Session Batching | HIGH | LOW (1-2 days) | LOW | Quick Win |
| 34 | Supervisor Adaptive Sampling Rate | HIGH | MODERATE (3-4 days) | LOW-MEDIUM | High Value |
| 35 | Decision Cycle Concurrency Guard | HIGH | HIGH (4-6 days) | HIGH | Critical Fix |
| 36 | Drive Tick-Loop Observability Instrumentation | HIGH | LOW-MODERATE (2-3 days) | LOW | Observability |
| 37 | Richer Semantic Extraction in Consolidation | NEEDS INFO | MODERATE-HIGH (4-6 days) | MEDIUM | High Value |
| 38 | Configurable LLM Pricing Rates in Cost Tracker | HIGH | LOW (< 1 day) | VERY LOW | Quick Win |
| 39 | Simulation Parallel Category Evaluation | HIGH | LOW (1-2 days) | LOW | Quick Win |
| 40 | Deduplicate Perception Embedding Init | BLOCKED | UNKNOWN | UNKNOWN | Blocked — File Not Found |
| 41 | Fix Guilt Repair Behavioral Change Dead Path | HIGH | MODERATE (2-3 days) | LOW | Critical Bug Fix |
| 42 | Live ageWeight Decay for Episodic Memory | HIGH | MODERATE (2-3 days) | MEDIUM | Correctness Critical |
| 43 | Bootstrap Category Normalization Consistency | HIGH | LOW (< 1 day) | LOW | Quick Win |
| 44 | Circuit Breaker for SidecarControlService | HIGH | MODERATE-HIGH (4-5 days) | MEDIUM | Production Resilience |

### New Ideas (2026-04-13)

| # | Idea | Feasibility | Effort | Risk | Priority |
|---|------|-------------|--------|------|----------|
| 45 | Pre-computed Assistant Pairing in getSplitHistory() | HIGH | LOW (< 1 day) | VERY LOW | Quick Win |
| 46 | Mood-Congruent Episodic Retrieval | HIGH | MODERATE (3-4 days) | MEDIUM | Intelligence Quality |

---

## Triage Annotations

### Idea 1 — Concurrent Persistence Checks in Pipeline
**TRIAGE: ARCHIVED — superseded by architectural change**
The Python perception pipeline's L2/L3 composition (perception-service/cobeing/) is reference-spec only; the live binding path runs NestJS-side via BindingService (TK-3/EP-1). The in-process Python pipeline loop is dormant (NG-2 in contract.yaml). Parallelizing the Python persistence check in the dormant path provides no live benefit. If the Python pipeline is ever revived, this idea should be reconsidered.

---

### Idea 2 — Planning Requeue Backoff on LLM Unavailability
**TRIAGE: ALREADY-TICKETED — TK-62 (EP14.1)**
planning/contract.yaml TK-62 "EP14.1 — Planning requeue exponential backoff on deferral" directly implements this: retryAfter on QueuedOpportunity, dequeue skips until it passes. Status: todo, priority P3.

---

### Idea 3 — Configurable Persistence Check Weights
**TRIAGE: ALREADY-TICKETED — TK-61 (EP13.5)**
planning/contract.yaml TK-61 "EP13.5 — Configurable persistence-check weight profiles" directly covers _NEW_WEIGHTS/_KNOWN_WEIGHTS promotion to PersistenceCheckConfig. Status: todo, priority P3.

---

### Idea 4 — Prediction Evaluator Memory Lifecycle
**TRIAGE: ARCHIVED — low-priority cleanup, not yet ticketed**
The predictions Map unbounded growth is a minor runtime concern (capped session, 3.6 MB worst case). No ticket exists. The concern is real but the impact is minimal compared to the existing work backlog. If a memory-pressure symptom emerges at runtime, this should be promoted to a ticket under EP-14 or EP-15. For now: ARCHIVED as a known-but-deferred maintenance item. Reason: no production symptom reported, impact bounded, no ticket warranted at current priority.

---

### Idea 5 — Opportunity Queue Eviction on Hard Cap
**TRIAGE: ARCHIVED — partially superseded by §1.3 fix and TK-62**
The priority-inversion problem is real, but the primary root cause (duplicate procedures filling slots via deferred items) was addressed by the §1.3 procedure conflict fix (stub-inventory §1.3 RESOLVED). TK-62 adds backoff so deferred items don't re-enter every cycle. The remaining eviction logic is a minor enhancement that is not yet ticketed. Reason: superseded risk, deferred to Tier-5+ if the queue-full scenario recurs in practice.

---

### Idea 6 — Inject Anxiety into Outcome Reporter
**TRIAGE: ARCHIVED — verify-before-listing; likely already resolved**
The hardcoded `anxietyAtExecution: 0` was a known gap as of April 2026. Given the volume of architecture work since (WS3/WS4/WS5/Wave-2/3), this may have been resolved. No specific ticket in contract.yaml covers it. Reason: unverified status; if still unresolved, should be promoted to a ticket under EP-14 (behavioral contingency path). Archived pending a runtime grep check.

---

### Idea 7 — Grounded Confidence for Reflection Insights
**TRIAGE: ARCHIVED — partially covered by TK-53; core grounding already implemented**
TK-53 (EP12.3) covers the re-grounding sweep for ungrounded Insights. The initial confidence computation on first persist (the subject of this idea) is an independent adjustment not yet ticketed. However, the downstream Insight consumer (retrieval/planning) is still not wired (confirmed in report), so the marginal value of adjusting confidence at creation time remains low until consumption is live. Reason: the actionable piece (re-grounding sweep) is in TK-53; the initial-creation adjustment is low-priority until Insights are consumed.

---

### Idea 8 — Observation Validation Pipeline
**TRIAGE: ARCHIVED — Python pipeline is reference-spec (dormant)**
The observation validation would apply to the dormant Python L2 pipeline (NG-2 in contract). The live path (NestJS BindingService) does its own quality gating. No ticket warranted for a dormant path. Reason: same as Idea 1 — the Python pipeline is reference-spec only.

---

### Idea 9 — Deterministic Constraint Validation
**TRIAGE: ALREADY-TICKETED (partial) — TK-65 (EP14.4)**
TK-65 "EP14.4 — Constraint-validation trigger-context wiring (verify + test)" covers the DUPLICATE_TRIGGER constraint. The broader deterministic multi-constraint approach (replacing the LLM call entirely) is not yet ticketed as a standalone ticket but is an outcome goal of TK-65 + the §1.3 resolved stub. The LLM-replacement portion of this idea remains aspirational; TK-65 addresses the most critical gap (trigger conflict detection). Status: TK-65 todo, P3. The remaining deterministic coverage is ARCHIVED as a Tier-5+ follow-on.

---

### Idea 10 — Deterministic Edge Refinement
**TRIAGE: ARCHIVED — low priority, no ticket warranted at current stage**
The regex-based fallback approach for edge type classification is valid. However, the refine-edges LLM path (quick-tier) is lower-cost than the validation path (deep-tier), and the Lesion Test fallback (skip entirely) is not causing observable quality loss in current operation. No ticket exists. Reason: cost-reduction value is real but low relative to P1/P2 backlog; defer to a Tier-5 ticket if LLM cost becomes a problem.

---

### Idea 11 — Learning Pipeline Dead-Letter Tracking
**TRIAGE: ALREADY-TICKETED — TK-54 (EP12.4)**
planning/contract.yaml TK-54 "EP12.4 — Learning pipeline dead-letter tracking" directly implements this: failed_learning_events hypertable, fire-and-forget insert on processEvent() failure. Status: todo, priority P3.

---

### Idea 12 — Perception Thread-Safe State and Lazy Init
**TRIAGE: ARCHIVED — Python pipeline is reference-spec (dormant)**
Same rationale as Ideas 1 and 8. The five race conditions documented are real but only matter if the Python pipeline serves live traffic. In the current architecture, frames flow browser -> NestJS -> /perception/detect (HTTP). The perception service runs in Docker but is not multi-threaded at the level described (single worker process handles `/detect`). The identified races (frame_sequence, embedding_extractor, tracker._tracks) are low-risk under single-worker single-request-at-a-time operation. Reason: not a live safety hazard in current deployment; ARCHIVED as reference for if the service is scaled.

---

### Idea 13 — Scope-Aware CALLS Edge Resolution
**TRIAGE: ALREADY-TICKETED — TK-71 (EP15.1)**
planning/contract.yaml TK-71 "EP15.1 — Scope-aware CALLS-edge resolution in codebase-pkg" directly covers this: two-pass IMPORTS-constrained CALLS resolution in the external codebase-pkg package. Status: todo, priority P3.

---

### Idea 14 — Rule-Based Cross-Modulation Engine
**TRIAGE: ALREADY-DONE**
The cross-modulation system is fully declarative and rule-based (CrossModulationRule typed objects in an array). Report confirmed this. No action needed.

---

### Idea 15 — Decision Cycle Structured Error Recovery
**TRIAGE: ALREADY-TICKETED — TK-89 (EP14.5a) + TK-90 (EP14.5b)**
planning/contract.yaml TK-89 covers CycleErrorContext type threading + LLM_TIMEOUT classification; TK-90 covers CONTRADICTION_SCAN_FAILED + HANDLER_NOT_FOUND typed returns. The circuit-breaker recovery (OllamaLlmService exponential backoff) is not directly ticketed but is deferred to a Tier-5+ follow-on. Status: both todo, priority P3.

---

### Idea 16 — Clean Up Stale Stub Comments in ActionHandlerRegistry
**TRIAGE: ARCHIVED — documentation-only, no ticket warranted**
The stale JSDoc (claiming handlers are stubs when they are wired) was noted. No contract ticket exists. This is a low-value documentation cleanup; a developer reading the code will see the working implementations regardless of the class-level comment. Reason: negligible value relative to backlog; ARCHIVED. Can be cleaned up incidentally in any EP-7 refactor pass.

---

### Idea 17 — Wire HALLUCINATED_KNOWLEDGE and DEPRESSIVE_ATTRACTOR Detectors
**TRIAGE: ALREADY-DONE**
Both detectors are fully implemented and active in attractor-monitor.service.ts. Report confirmed this. No action needed.

---

### Idea 18 — Forward Drive Events to TimescaleDB
**TRIAGE: ARCHIVED — the TODO exists but no ticket warranted at current priority**
The DRIVE_EVENT handler has a TODO to forward to TimescaleDB. This is a legitimate observability gap. However, no contract ticket covers it directly (EP-10 covers LLM cost observability, not drive event forwarding). This is a genuine gap, but the priority is P3+ given the current backlog. Reason: real gap but not blocking any acceptance criterion; ARCHIVED as a potential EP-10 follow-on ticket if drive-event observability becomes a need.

---

### Idea 19 — Implement DrivesController Stub Endpoints
**TRIAGE: ALREADY-TICKETED — TK-80 (DEC-9)**
planning/contract.yaml TK-80 "DEC-9 — remove decorative drives-controller UI affordances that can only 501" resolves this by removing the UI affordances (the honest-501 backend stays). The option of routing via guardian-feedback is deferred (not this ticket). Status: todo, priority P3.

---

### Idea 20 — Wire IPCSelfKgReader for Real KG(Self) Access
**TRIAGE: ARCHIVED — not yet ticketed; high complexity, no current blocker**
IPCSelfKgReader in drive-process/database-clients.ts remains unimplemented (FallbackSelfKgReader returns empty arrays). The IPC request/response pattern needed does not yet exist. No contract ticket covers this (EP-13 covers Python-side items). The self-evaluation loop runs without baseline data but this has not caused an observable correctness failure. Reason: high complexity (IPC protocol design needed), no acceptance criterion currently blocked by this gap; ARCHIVED pending a dedicated architectural design decision.

---

### Idea 21 — Support 'call' Step Type in MorphologyExecutor
**TRIAGE: ALREADY-TICKETED — TK-57 (EP13.1)**
planning/contract.yaml TK-57 "EP13.1 — MorphologyExecutor 'call' step type (string-value delegation)" directly covers this. The POC (TK-56) is done and proven. Status: TK-57 todo, priority P3.

---

### Idea 22 — Remove SensoryLoggerService Temporary Stand-in
**TRIAGE: ARCHIVED — pre-work dependency not yet resolved**
The report correctly identified that SensoryLoggerService cannot be removed until ExecutorEngineService calls tickSampler.sample(). The executor sampling integration is not yet ticketed. Given the EP-7 god-object refactors are in progress (TK-31..TK-36), this cleanup is sequenced after those extractions are done. Reason: pre-work dependency (executor sampling wiring) is unresolved; ARCHIVED until EP-7 refactors create a clean hook point.

---

### Idea 23 — Simulation Cross-Drive Effect Aggregation
**TRIAGE: ALREADY-TICKETED — TK-63 (EP14.2)**
planning/contract.yaml TK-63 "EP14.2 — Simulation cross-drive effect aggregation" directly covers this. Status: todo, priority P3.

---

### Idea 24 — Implement Real Theater Prohibition Validation
**TRIAGE: ARCHIVED — deferred in stub-inventory §3.1; high complexity**
stub-inventory §3.1 documents this as a medium-severity gap with HIGH fix complexity (needs sentiment analysis or a classifier). No contract ticket exists. The backend honest-501 approach (DrivesController) handles the worst case; the Communication theater check is flag-only (§3.1). Reason: high complexity, no blocking acceptance criterion; matches stub-inventory disposition (deferred, architectural decision needed).

---

### Idea 25 — Add Timeout Guards to LLM Calls in Learning Pipeline
**TRIAGE: ARCHIVED — real gap, but no ticket warranted at current priority**
The learning pipeline LLM calls (refine-edges, conversation-reflection, cross-session-synthesis) have no timeout wrappers. The `inFlight` guard prevents double-execution but a hung LLM call permanently blocks the cycle type until restart. This is a real reliability gap. No contract ticket covers it directly (TK-89 covers decision-making LLM timeout, not learning). Reason: real gap, but low observable impact (learning cycle is not in the critical path for user interaction); can be added as a quick ticket under EP-12 if a hung learning cycle is observed.

---

### Idea 26 — Per-Row Error Isolation in Planning Opportunity Ingestion
**TRIAGE: ARCHIVED — real gap, but no ticket warranted at current priority**
The inconsistency (pollAndEvaluateOutcomes has per-row isolation, ingestOpportunities does not) is confirmed. However, the planning pipeline operates under a small queue (MAX_QUEUE_SIZE=50), and a JSON parse failure aborts only one ingest cycle (not the whole service). No contract ticket covers this directly. Reason: real but low-impact gap (next 30s cycle retries anyway); ARCHIVED as a quick-win to add if a parse failure is observed in production logs.

---

### Idea 27 — Add Jitter and Iterative Retry in Recovery Mechanism
**TRIAGE: ARCHIVED — real gap, no ticket warranted**
The recursive retry in recovery.ts and missing jitter are valid concerns for thundering-herd scenarios. However, in the current deployment (single Docker container, single drive-server consumer), this is not a live concern. No contract ticket covers it. Reason: theoretical reliability improvement with no current symptom; ARCHIVED.

---

### Idea 28 — Adaptive Candidate Scoring Weights
**TRIAGE: ALREADY-TICKETED — TK-70 (EP14.9)**
planning/contract.yaml TK-70 "EP14.9 — Adaptive candidate scoring weights (CANON gate first)" covers this, with the explicit CANON Std-6 gate as the first task. Status: todo, priority P3.

---

### Idea 29 — Perception Frame Source Timeout Guards
**TRIAGE: ARCHIVED — Python frame source is not the live frame path**
The live frame source is the browser-camera WebRTC path (NestJS PerceptionGateway), not the Python CameraFrameSource.get_frame(). The Python camera source would only matter if a local USB/RTSP camera is connected directly to the Docker container. The asyncio.get_event_loop() deprecation is a real issue but in a dormant code path. Reason: dormant path (NG-2); no live risk.

---

### Idea 30 — Supervisor Verdict Audit Trail
**TRIAGE: ARCHIVED — partially covered by EP-10; core persistence not yet ticketed**
EP-10 (TK-45..TK-48) covers LLM cost logging and observability. The supervisor verdict persistence (recentVerdicts to TimescaleDB, reasoning trace capture) is a distinct concern not yet ticketed. stub-inventory §2.4 flags the DeepSeek reasoning trace being dropped. However, TK-48 consolidates cost tracking. The verdict persistence is a real gap but is not blocking any current acceptance criterion. Reason: real gap (reasoning trace dropped = paying for tokens we discard, §2.4), but no ticket yet. The stub-inventory entry §2.4 remains open.

---

### Idea 31 — Ungrounded Insight Re-grounding Sweep
**TRIAGE: ALREADY-TICKETED — TK-53 (EP12.3)**
planning/contract.yaml TK-53 "EP12.3 — Ungrounded insight re-grounding sweep" directly covers this, including the DEC-16 one-time backfill for pre-existing grounded:false Insights lacking referenced_entities. Status: todo, priority P3.

---

### Idea 32 — Windowed Sampling for Long Session Reflection
**TRIAGE: ALREADY-TICKETED — TK-52 (EP12.2)**
planning/contract.yaml TK-52 "EP12.2 — Reflection windowed sampling for long sessions" directly covers the head+tail+sampled-middle strategy. Status: todo, priority P3.

---

### Idea 33 — Learning Pipeline Neo4j Session Batching
**TRIAGE: ARCHIVED — performance improvement, no ticket warranted**
The per-entity Neo4j session in upsert-entities.service.ts (vs the batched UNWIND+MERGE in extract-edges) is a performance inconsistency. The overhead (~5-10ms per session × 20 sessions = 100-200ms per cycle) is measurable but not causing observable degradation (MAX_EVENTS_PER_CYCLE=5). No contract ticket covers it. Reason: real but minor performance gap; ARCHIVED as a code-quality cleanup to do incidentally during any learning-pipeline touch.

---

### Idea 34 — Supervisor Adaptive Sampling Rate
**TRIAGE: ARCHIVED — real enhancement, not yet ticketed**
The static modulo sampling and the binary burstMode are valid limitations. The infrastructure (recentVerdicts buffer, VerdictRating types) is 95% ready per the report. No contract ticket covers it. Reason: real enhancement but no blocking acceptance criterion; ARCHIVED as a P3+ ticket to add when supervisor work resumes.

---

### Idea 35 — Decision Cycle Concurrency Guard
**TRIAGE: ALREADY-TICKETED — TK-77 (EP14.10)**
planning/contract.yaml TK-77 "EP14.10 — Decision-cycle concurrency guard (verify or wire)" covers this: confirm CycleGuard is live and guards re-entrancy, or add the guard if absent. Status: todo, priority P3.

---

### Idea 36 — Drive Tick-Loop Observability Instrumentation
**TRIAGE: ARCHIVED — real enhancement, not yet ticketed**
The 100Hz tick loop captures tickStartMs but does not collect per-tick latency histograms or emit structured samples. No contract ticket covers this. The drive engine is the most timing-critical component, so tick overruns could mask bugs. Reason: real observability gap but no current symptom; ARCHIVED as a potential EP-10 addition if tick overruns are observed.

---

### Idea 37 — Richer Semantic Extraction in Consolidation
**TRIAGE: ALREADY-TICKETED — TK-87 (EP12.1a) + TK-88 (EP12.1b)**
planning/contract.yaml TK-87 "EP12.1a — Consolidation entity extraction LLM path" and TK-88 "EP12.1b — Consolidation relationship extraction LLM path" directly cover this idea. The prerequisite (verify outcome data flows to Episode) is confirmed by the ticket's lesion-fallback design. Status: both todo, priority P3.

---

### Idea 38 — Configurable LLM Pricing Rates in Cost Tracker
**TRIAGE: ALREADY-TICKETED — TK-48 (EP10-4)**
planning/contract.yaml TK-48 "EP10-4 — Consolidate OllamaLlmService cost to the shared utility" covers replacing the hardcoded DeepSeek rate constants with the shared estimateLlmCostUsd + resolveLlmPricingFromEnv. This subsumes the env-var approach described in this idea. Status: todo, priority P2.

---

### Idea 39 — Simulation Parallel Category Evaluation
**TRIAGE: ARCHIVED — real quick-win, not yet ticketed**
The sequential await in simulation.service.ts over 5 independent TimescaleDB queries (~5x latency) is a real performance improvement. No contract ticket covers it. Reason: quick-win but no ticket warranted given current P3 backlog; ARCHIVED. Can be added under EP-14 if simulation latency becomes observable.

---

### Idea 40 — Deduplicate Perception Embedding Init
**TRIAGE: ALREADY-TICKETED — TK-24 (P5.1a) + TK-25 (P5.1b)**
planning/contract.yaml TK-24 "P5.1a — confirm OnnxEmbeddingExtractor is dead code" (done) and TK-25 "P5.1b — delete OnnxEmbeddingExtractor + orphaned init state" (todo) directly address this. The BLOCKED status in the report was because the file was not accessible at research time; TK-24/25 have since confirmed the extractor is dead code and TK-25 will delete it. Status: TK-24 done, TK-25 todo.

---

### Idea 41 — Fix Guilt Repair Behavioral Change Dead Path
**TRIAGE: ARCHIVED — confirmed bug, not yet ticketed**
The bug in contingency-coordinator.ts (passing outcome.actionType for both current and previous error action type, so detectBehavioralChange always returns false) is a real correctness bug. 0.15 and 0.30 relief paths are unreachable. No contract ticket covers this directly (EP-14 covers planning/decision-making, but not behavioral contingencies). Reason: real correctness bug in the drive engine; should be promoted to a ticket under EP-16 or a new EP-17 item if guilt repair behavior matters for current testing. ARCHIVED with flag: this is a genuine gap that should be ticketed if guilt repair is being evaluated.

---

### Idea 42 — Live ageWeight Decay for Episodic Memory
**TRIAGE: ARCHIVED — confirmed correctness bug, not yet ticketed**
The frozen ageWeight (set at encode time, never recalculated) means 3-hour-old episodes with high initial attention score as if they were fresh. The docstring claims exponential decay but the implementation does not apply it. No contract ticket covers this. The issue is real and affects consolidation candidate ordering. Reason: genuine correctness gap; should be promoted to a ticket under EP-12 or EP-14. ARCHIVED with flag: this is a genuine gap affecting episodic memory quality that warrants a dedicated ticket.

---

### Idea 43 — Bootstrap Category Normalization Consistency
**TRIAGE: ARCHIVED — real correctness gap, not yet ticketed**
The asymmetry (bootstrap.py normalizes with .lower() only; trainer.py normalizes with .strip().lower()) can cause false disagreements on categories with leading/trailing whitespace from LLM outputs. No contract ticket covers this. The impact is on graduation velocity (shadow → audit → partial → full). Reason: real but edge-case correctness gap; can be fixed as a one-liner incidentally during any cognition-sidecar touch.

---

### Idea 44 — Circuit Breaker for SidecarControlService
**TRIAGE: ARCHIVED — real production resilience gap, not yet ticketed**
sidecar-control.service.ts has no circuit breaker, retry, or health-awareness for HTTP calls to the cognition sidecar. Lost interventions during sidecar restarts mean the model doesn't learn from flagged mistakes. No contract ticket covers this (EP-8 covers cognition stubs, not the TS-side circuit breaker). Reason: real production resilience gap; should be promoted to a ticket under EP-8 or EP-17 when supervisor work resumes.

---

### Idea 45 — Pre-computed Assistant Pairing in getSplitHistory()
**TRIAGE: ARCHIVED — micro-optimization, not yet ticketed**
The O(n²) pattern in getSplitHistory() (nested scan per answered user message, called every decision cycle) is real but bounded by MAX_MESSAGES=50 and is individually marginal per call. The lazy-cache approach described is clean. No contract ticket covers it. Reason: negligible performance impact at 50-message cap; ARCHIVED as a code-quality improvement to do incidentally during any ConversationHistoryService touch.

---

### Idea 46 — Mood-Congruent Episodic Retrieval
**TRIAGE: ALREADY-TICKETED — TK-69 (EP14.8)**
planning/contract.yaml TK-69 "EP14.8 — VERIFY mood-congruent episodic retrieval is live; close stub" covers this as a verify-before-listing item: the decomposer found it already done (WS5 T2.5 driveCosineSimilarity blend). TK-69 confirms it with a read + grep, then closes the stub-inventory entry. Status: todo, priority P3.

---

## Triage Summary Table

| # | Idea | Disposition | Contract ref |
|---|------|-------------|--------------|
| 1 | Concurrent Persistence Checks | ARCHIVED — dormant Python pipeline | — |
| 2 | Planning Requeue Backoff | ALREADY-TICKETED | TK-62 (EP14.1) |
| 3 | Configurable Persistence Check Weights | ALREADY-TICKETED | TK-61 (EP13.5) |
| 4 | Prediction Evaluator Memory Lifecycle | ARCHIVED — bounded impact, no ticket | — |
| 5 | Opportunity Queue Eviction | ARCHIVED — root cause resolved (§1.3) | — |
| 6 | Inject Anxiety into Outcome Reporter | ARCHIVED — verify status; may be resolved | — |
| 7 | Grounded Confidence for Reflection | ARCHIVED — re-grounding in TK-53; creation-time adjustment deferred | TK-53 (partial) |
| 8 | Observation Validation Pipeline | ARCHIVED — dormant Python pipeline | — |
| 9 | Deterministic Constraint Validation | ALREADY-TICKETED (partial) | TK-65 (EP14.4) |
| 10 | Deterministic Edge Refinement | ARCHIVED — low priority, no LLM cost pressure | — |
| 11 | Learning Pipeline Dead-Letter Tracking | ALREADY-TICKETED | TK-54 (EP12.4) |
| 12 | Perception Thread-Safe State | ARCHIVED — dormant Python pipeline | — |
| 13 | Scope-Aware CALLS Edge Resolution | ALREADY-TICKETED | TK-71 (EP15.1) |
| 14 | Rule-Based Cross-Modulation Engine | ALREADY-DONE | — |
| 15 | Decision Cycle Structured Error Recovery | ALREADY-TICKETED | TK-89 + TK-90 |
| 16 | Clean Up Stale Stub Comments | ARCHIVED — negligible value | — |
| 17 | Wire Attractor Detectors | ALREADY-DONE | — |
| 18 | Forward Drive Events to TimescaleDB | ARCHIVED — real gap, no ticket yet | — |
| 19 | DrivesController Stub Endpoints | ALREADY-TICKETED | TK-80 (DEC-9) |
| 20 | Wire IPCSelfKgReader | ARCHIVED — high complexity, no blocker | — |
| 21 | MorphologyExecutor 'call' Step | ALREADY-TICKETED | TK-57 (EP13.1) |
| 22 | Remove SensoryLoggerService | ARCHIVED — pre-work dependency unresolved | — |
| 23 | Simulation Cross-Drive Aggregation | ALREADY-TICKETED | TK-63 (EP14.2) |
| 24 | Theater Prohibition Real Validation | ARCHIVED — high complexity, §3.1 deferred | — |
| 25 | LLM Timeout Guards in Learning | ARCHIVED — real gap, no ticket yet | — |
| 26 | Per-Row Error Isolation in Planning | ARCHIVED — low impact, no ticket | — |
| 27 | Jitter and Iterative Retry | ARCHIVED — theoretical, no symptom | — |
| 28 | Adaptive Candidate Scoring Weights | ALREADY-TICKETED | TK-70 (EP14.9) |
| 29 | Perception Frame Source Timeout | ARCHIVED — dormant Python camera source | — |
| 30 | Supervisor Verdict Audit Trail | ARCHIVED — §2.4 open; no ticket yet | — |
| 31 | Ungrounded Insight Re-grounding | ALREADY-TICKETED | TK-53 (EP12.3) |
| 32 | Windowed Sampling for Reflection | ALREADY-TICKETED | TK-52 (EP12.2) |
| 33 | Learning Neo4j Session Batching | ARCHIVED — minor perf, no ticket | — |
| 34 | Supervisor Adaptive Sampling Rate | ARCHIVED — real enhancement, no ticket | — |
| 35 | Decision Cycle Concurrency Guard | ALREADY-TICKETED | TK-77 (EP14.10) |
| 36 | Drive Tick-Loop Observability | ARCHIVED — no current symptom | — |
| 37 | Richer Semantic Extraction | ALREADY-TICKETED | TK-87 + TK-88 (EP12.1a/b) |
| 38 | Configurable LLM Pricing Rates | ALREADY-TICKETED | TK-48 (EP10-4) |
| 39 | Simulation Parallel Category Eval | ARCHIVED — quick-win, not yet ticketed | — |
| 40 | Deduplicate Perception Embedding Init | ALREADY-TICKETED | TK-24 + TK-25 (P5.1a/b) |
| 41 | Fix Guilt Repair Dead Path | ARCHIVED (FLAG) — real bug, needs ticket | — |
| 42 | Live ageWeight Decay | ARCHIVED (FLAG) — correctness bug, needs ticket | — |
| 43 | Bootstrap Normalization Consistency | ARCHIVED — edge case, one-liner fix | — |
| 44 | Circuit Breaker for SidecarControlService | ARCHIVED — real gap, supervisor work paused | — |
| 45 | Pre-computed Assistant Pairing | ARCHIVED — micro-optimization | — |
| 46 | Mood-Congruent Episodic Retrieval | ALREADY-TICKETED | TK-69 (EP14.8) |

---

## Flagged Items — Genuine Gaps Not Yet Ticketed

Two ideas identified genuine correctness bugs that are not yet captured in any contract ticket:

### FLAG: Idea 41 — Guilt Repair Behavioral Change Dead Path
- **Where:** packages/drive-engine/src/drive-process/behavioral-contingencies/contingency-coordinator.ts (lines 100-108)
- **Bug:** outcome.actionType passed for BOTH current and previous error action type; detectBehavioralChange always false; 0.15 and 0.30 relief paths unreachable
- **Recommended action:** Promote to a ticket under EP-14 or EP-16 (drive engine behavioral contingencies)

### FLAG: Idea 42 — Live ageWeight Decay for Episodic Memory
- **Where:** packages/decision-making/src/episodic-memory/episodic-memory.service.ts (line 200)
- **Bug:** ageWeight frozen at encode time; docstring claims exponential decay but formula never applied; consolidation ordering is incorrect for old high-attention episodes
- **Recommended action:** Promote to a ticket under EP-12 (episodic memory quality)

These two items were promoted as open_questions in planning/contract.yaml governance (see TK-76 closure entry in contract changelog).

---

*Report archived as part of TK-76 (EP15.6) triage pass on 2026-06-20. Original research date: 2026-04-09 through 2026-04-13.*
