# decision-making — Architecture Reference

> Living document. Last updated: 2026-06-13. Auto-generated from full-file reads; verify before trusting any single line.

---

## Overview

The `packages/decision-making` package is CANON Subsystem 1 — the cognitive decision loop that receives fused multimodal sensory frames and produces grounded, drive-aware responses. Its core abstraction is an **8-state finite state machine**: IDLE → CATEGORIZING → RETRIEVING → PREDICTING → ARBITRATING → EXECUTING → OBSERVING → LEARNING → IDLE. Every admitted user turn traverses this sequence exactly once; self-initiated drive-pressure ticks traverse the same loop. The public facade is `DecisionMakingService`, which exposes `enqueueTurn()` for Communication-layer callers and drives everything else internally.

Data flows from the **sensory pipeline** (a set of per-modality encoders, a registry, a tick sampler, and a fusion service) into `ProcessInputService`, which categorizes the frame, extracts entities, and queries the **World Knowledge Graph** (Neo4j via `WkgContextService`) for candidate `ActionProcedure` nodes. `ActionRetrieverService` scores candidates against a live query embedding using cosine similarity. `ArbitrationService` then selects a single action via dual-process logic: **Type 1** (reflexive, high-confidence graduated procedure), **Type 2** (deliberative, LLM-backed), or **SHRUG** (no candidate clears the dynamic threshold computed by `ThresholdComputationService`). Execution is dispatched through `ActionHandlerRegistryService` (for Type 1 procedures) or `DeliberationService` (a 5-step LLM pipeline for Type 2). Outcomes are encoded as episodes in `EpisodicMemoryService`, and `ConfidenceUpdaterService` applies ACT-R updates. The knowledge use→reinforce edge (`WkgContextService.reinforceFactNode`) closes the compounding memory loop for grounded recalls.

**Concurrency and safety** are handled by `CycleGuardService`: a two-lane FIFO queue (guardian-priority, depth-12), watchdog timeout (25 s), epoch fence (anti-zombie), and circuit breaker (3 consecutive kills → degraded mode). `LatentSpaceService` maintains a three-layer (hot/warm/cold pgvector) pattern store for Type 1 fast-path matching. **Monitoring** is handled by `AttractorMonitorService` (five CANON pathological attractor detectors) and `MoodBleedMonitorService` (hostile-interlocutor affect detection). All events are batched and persisted to TimescaleDB by `DecisionEventLoggerService`. The subsystem never imports from CommunicationModule, LearningModule, or PlanningModule directly — cross-subsystem coupling is exclusively through TimescaleDB events and the WKG.

---

## File-by-File

### action-handlers/action-handler-registry.service.ts

**Role:** Dispatcher registry for action steps in the EXECUTING state.

Maintains a `Map<string, ActionStepHandler>` and routes each `ActionStep` to its registered handler at runtime. Five built-in handlers are registered at construction: `LLM_GENERATE` (delegates to `ILlmService.complete()`, keeps last 10 conversation turns, builds system prompt from drive state + person model); `WKG_QUERY` (queries `WkgContextService`); `TTS_SPEAK` (stubs synthesis, sets `ttsRequested=true`); `LOG_EVENT`; and `RESEARCH_ENTITY` (parallel SearXNG queries + LLM JSON extraction, writes low-confidence nodes/edges to WKG). The `execute()` method returns `null` if no handler is found rather than throwing.

- **Exports:** `ActionHandlerRegistryService`, `ActionCycleContext`, `ActionStepHandler`
- **Key constants:** `maxTokens=256` / `temperature=0.7` (LLM_GENERATE); `temperature=0.3` / `maxTokens=512` (RESEARCH_ENTITY extraction); `WEB_RESEARCH_CONFIDENCE=0.30`; `10_000ms` SearXNG timeout; `slice(-10)` conversation history; `slice(0,5)` search results
- **Deps:** `@sylphie/shared`, `WkgContextService`, `@nestjs/common`, `@nestjs/config`
- **Gotchas:** `LLM_SERVICE` is `@Optional` — warns if unavailable. `RESEARCH_ENTITY` writes `confidence=0.30` nodes to WKG via web search; JSON parsing strips markdown backticks but fails silently on malformed LLM output. `WKG_QUERY` and `TTS_SPEAK` are logging stubs. Comment on line 209 notes conversation history causes old-exchange references — excluded from system prompt.

---

### action-retrieval/action-retriever.service.ts

**Role:** Retrieves `ActionProcedure` candidates from Neo4j with LRU caching and drive-aware composite scoring.

On `onModuleInit`, bootstraps 8 seed procedures (greet, acknowledge, ask_clarification, etc.) via MERGE semantics with `confidence=0.60`. The `retrieve()` method: checks a 50-entry LRU cache (5-min TTL); queries Neo4j for nodes with `confidence >= 0.50`; scores via `W_CONFIDENCE×0.50 + W_CONTEXT×0.30 + W_DRIVE×0.20`; context score is cosine similarity between live nomic QUERY embedding and stored DOCUMENT trigger embedding; `driveRelevanceScore` is hardcoded `0.0` (procedures no longer carry drive effects). Neo4j and TextEncoder are both `@Optional` with graceful degradation.

- **Exports:** `ActionRetrieverService`
- **Key constants:** `LRU_CAPACITY=50`; `LRU_TTL_MS=300000`; `W_CONFIDENCE=0.50`, `W_CONTEXT=0.30`, `W_DRIVE=0.20`; `BASE_CONFIDENCE=0.60` (seeds); `CONFIDENCE_THRESHOLDS.retrieval=0.50`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `latent-space/vector-math`, `inputs/encoders/text.encoder`, `interfaces/decision-making.interfaces`
- **Gotchas:** `driveRelevanceScore` is always `0.0`. LRU uses Map insertion order, not a true doubly-linked list. TextEncoder seeds without embeddings store `triggerEmbedding=null` and fail-closed. Prior sha256→Jaccard context matching scored ~0 for all candidates (replaced by cosine similarity).

---

### arbitration/arbitration.service.ts

**Role:** Dual-process (Type 1 / Type 2 / SHRUG) action arbitration with dynamic threshold and context-match gating.

7-step algorithm: (1) empty candidates → SHRUG; (2) compute dynamic threshold via `IThresholdComputationService` (fallback `0.50`); (3) filter and sort candidates; (4) find best Type 1: `procedureData !== null` AND `confidence > 0.80` AND `contextMatchScore >= CONTEXT_MATCH_FLOOR (0.55)`; (5) if Type 1, scan contradictions; (6) if Type 1 and no contradictions → `TYPE_1`; (7) qualified but no Type 1 → `TYPE_2`; no candidates above threshold → SHRUG with `GapType.LOW_CONFIDENCE`. Accumulates `type1Count`, `type2Count`, `shrugCount` for attractor detection.

- **Exports:** `ArbitrationService`, `ArbitrationMetrics`, `CONTEXT_MATCH_FLOOR`
- **Key constants:** `CONTEXT_MATCH_FLOOR=0.55`; `CONFIDENCE_THRESHOLDS.graduation=0.80`; `CONFIDENCE_THRESHOLDS.retrieval=0.50`
- **Deps:** `@sylphie/shared`, `decision-making.interfaces`, `decision-making.tokens`
- **Gotchas:** `CONTEXT_MATCH_FLOOR` was raised from `0.20` to `0.55` on 2026-06-10 after the broken Jaccard fingerprint was replaced. Floor is marked EMPIRICAL TUNING REQUIRED. `TYPE_1_SUPPRESSED_BY_CONTEXT_FLOOR` path nulls `procedureData` to force novel deliberation — CANON Standard 4 enforcement.

---

### arbitration/contradiction-scanner.service.ts

**Role:** Pre-commit coherence check — scans Neo4j for `CONTRADICTS` edges before an action is committed.

Runs a single Neo4j query `MATCH (p:ActionProcedure {id: $id})-[:CONTRADICTS]-(c) RETURN c.claim, c.existingFact, c.confidence` on the WORLD instance. Type 2 candidates (no `procedureId`) are skipped. All failures degrade gracefully (no exception thrown, returns clean no-contradiction result).

- **Exports:** `ContradictionScannerService`
- **Deps:** `@nestjs/common`, `@sylphie/shared`
- **Gotchas:** Neo4j unavailability is designed as a non-failure mode. No retry on query failure. Heavy contradiction resolution is deferred to the Learning subsystem's consolidation pipeline.

---

### concurrency/cycle-guard.service.ts

**Role:** Decision-cycle concurrency guard — serialized two-lane FIFO queue, watchdog, circuit breaker, and epoch fence.

Enforces single-cycle-at-a-time semantics via boolean `tickInFlight` mutex. Two queues: `guardianLane` and `normalLane`, total depth `QUEUE_DEPTH=12`. Overflow evicts the oldest waiting non-guardian (never head-of-line or guardians). Watchdog fires at `WATCHDOG_T_MAX_MS=25_000`: calls `executorEngine.forceIdle()`, increments `cycleEpoch` (anti-zombie fence), emits SHRUG to wedged turn. Circuit breaker trips after 3 consecutive kills (degraded mode: all turns receive SHRUGs). 2 consecutive probe successes every 30 s exit degraded mode. Emits `QueuePositionSnapshot` on every enqueue/drain for honest queue-position messages to waiting speakers (WS4 T6). Observable streams: `turnDeclined$`, `cycleWatchdogKill$`, `cycleCompleted$`, `circuitBreakerState$`, `queuePositionUpdates$`.

- **Exports:** `CycleGuardService`, `DeclineReason`, `TurnDeclinedEvent`, `WatchdogKillEvent`, `TurnCompletedEvent`, `QueuePositionSnapshot`, `BreakerStateEvent`, `CycleRunnerFn`, `ShrugEmitterFn`, `IsExternallyBusyFn`
- **Key constants:** `QUEUE_DEPTH=12`; `WATCHDOG_T_MAX_MS=25_000`; `BREAKER_KILL_THRESHOLD=3`; `BREAKER_PROBE_SUCCESS_THRESHOLD=2`; `BREAKER_PROBE_INTERVAL_MS=30_000`
- **Deps:** `@nestjs/common`, `rxjs`, `decision-making.interfaces`, `decision-making.tokens`, `inbound-turn`, `@sylphie/shared`
- **Gotchas:** Line 525-526: silent turn drop if `cycleRunner` not registered. Degraded mode SHRUGs drain immediately without running LLM cycles (honest per CANON). `isExternallyBusy` callback prevents queue drains during self-ticks; caller must call `notifyExternalComplete()` in finally block.

---

### concurrency/cycle-guard.service.spec.ts

**Role:** Jest unit test suite for `CycleGuardService` — 9 acceptance criteria (WS4 T1) plus invariants.

Tests Q1.1 burst capacity, Q1.2 serialization, Q1.3 FIFO ordering, Q1.4 watchdog recovery, Q1.5 zombie guard (CRITICAL — epoch fence), Q1.6 back-pressure (13 turns → exactly 1 decline), Q1.7 guardian priority, Q1.8 lesion parity, Q1.9 circuit breaker. Uses Jest fake timers throughout.

- **Key constants (test):** `WATCHDOG_MS=25000`, `PROBE_INTERVAL_MS=30000`, `QUEUE_DEPTH_MAX=12`, `CIRCUIT_BREAKER_KILL_THRESHOLD=3`, `CIRCUIT_BREAKER_PROBE_SUCCESS_THRESHOLD=2`
- **Gotchas:** Q1.5 (zombie guard) is flagged CRITICAL at spec site line 1248. Pre-fix section (lines 785–930) tests `drainNext` vs `selfTickInFlight` race.

---

### concurrency/inbound-turn-queue.spec.ts

**Role:** Acceptance-criteria test for WS4 Ticket 2 — per-turn text threading in burst conditions.

Validates: each cycle receives its own injected text (not null or a neighbor's); emitted `CycleResponse` `turnId`s match intake; FIFO ordering under burst with zero null-text cycles (regression for pre-fix bug where cycles 2–5 sampled null).

- **Gotchas:** Mocked sampler clears `samplerTextSlot=null` after each `sample()` to prevent cross-turn pollution.

---

### concurrency/inbound-turn.ts

**Role:** `InboundTurn` interface — minimal queue entry carrying identity-lite fields for concurrency routing.

Fields: `turnId`, `isGuardian`, `receivedAt`, `enqueuedAt`, `text`, and (WS4 T3) optional `userId`, `username`, `socketId` from JWT claims. Tokenless legacy default: `userId='guardian'`, `isGuardian=true` (Ticket 4 will flip to `userId='guest'`, `isGuardian=false`).

- **Exports:** `InboundTurn`
- **Gotchas:** Pure type definition only. Tokenless default preserved for backward compat; Ticket 4 will change this.

---

### concurrency/queue-position.spec.ts

**Role:** Unit tests for queue-position notification seam (WS4 T6).

Pins 6 acceptance criteria: positions 1/2/3 on enqueue; shifted positions after drain; guardian inserts at position 1; overflow eviction recomputes positions; empty/immediate turns emit no snapshot; snapshots carry correct `socketId`/`userId`/position.

- **Key constants (test):** `QUEUE_DEPTH=12`
- **Gotchas:** Tests the notification seam only — full delivery path (two-socket gateway check) is not tested here.

---

### concurrency/targeted-delivery.spec.ts

**Role:** Unit tests for WS4 Ticket 4 — targeted delivery routing and per-turn person context selection.

Tests a 4-state routing table (TARGETED / USER_FALLBACK / BROADCAST / LOGGED_DROP) and `getPersonModelForTurn(userId)` to prevent concurrent turn thrashing on the global `activePersonId` slot. 13 test cases covering two-user isolation, stale socketId fallback, full disconnection, and per-turn context isolation.

- **Key constants (test):** `OPEN=1`, `CLOSED=3`
- **Gotchas:** `routeDelivery` is a pure test-only function mirroring production logic — not exported or used elsewhere.

---

### confidence/confidence-updater.service.ts

**Role:** ACT-R 3-path confidence updater for action procedures.

Three update paths: (1) `reinforced` (increment count, recompute, apply guardian weight, check graduation); (2) `decayed` (recompute with current timestamp); (3) `counter_indicated` (reduce base by `0.15`, apply 3× guardian correction weight, recompute, check demotion). Confidence formula: `min(1.0, base + 0.12 × ln(count) - decayRate × ln(hours + 1))`. Guardian feedback: 2× confirmation, 3× correction (CANON Standard 5). Rolling 10-entry MAE window per action.

- **Exports:** `ConfidenceUpdaterService`, `IConfidenceUpdaterService`, `ActionConfidenceRecord`
- **Key constants:** `COUNTER_INDICATION_REDUCTION=0.15`; `MAX_MAE_WINDOW=10`
- **Deps:** `@sylphie/shared`, `@nestjs/common`, `decision-making.tokens`
- **Gotchas:** Event emission (CONFIDENCE_UPDATED, TYPE_1_GRADUATION, TYPE_1_DEMOTION) is deferred — executor is responsible for cycle-level correlation. MAE returns `0.0` when window is empty; graduation check `MAE < 0.10` passes conservatively. `DriveName.InformationIntegrity` does not exist; service avoids referencing it.

---

### decision-making.module.ts

**Role:** NestJS module — DI configuration for the full 8-state cognitive loop (25+ services).

Imports `DriveEngineModule` (read-only `DRIVE_STATE_READER` and `ACTION_OUTCOME_REPORTER`) and `TimescaleModule`. Provides services in three groups: cognitive loop, reasoning/knowledge, and sensory pipeline. Binds `LLM_SERVICE` to `OllamaLlmService`. Exports public API (`DECISION_MAKING_SERVICE`, `LLM_SERVICE`, `WkgContextService`), metrics services (`ARBITRATION_SERVICE`, `ATTRACTOR_MONITOR_SERVICE`), system-reset targets, and all sensory pipeline services. `CycleGuardService` is exported so `CommunicationService` can subscribe to `queuePositionUpdates$`.

- **Exports:** `DecisionMakingModule` plus 20 DI tokens (see tokens file)
- **Deps:** `@nestjs/common`, `@sylphie/drive-engine`, `@sylphie/shared`
- **Gotchas:** `OllamaLlmService` is hardcoded as `LLM_SERVICE` — no provider-swap mechanism at module level. `SensoryStreamLoggerService` is instantiated but neither exported nor injected by anything visible in this file. `WkgContextService` and `DeliberationService` are class-based (not token-indirected) providers.

---

### decision-making.service.ts

**Role:** Main orchestrator for the 8-state cognitive decision cycle — sole public facade for Subsystem 1.

Two trigger paths: (1) timer-driven self-ticks when drive pressure exceeds `IDLE_PRESSURE_THRESHOLD=4.0` after a 30-second input gap, rate-limited to `SELF_INITIATE_COOLDOWN_MS=10_000`; (2) event-driven queue-admitted turns via `enqueueTurn()` through `CycleGuardService`. `processInput()` runs the full FSM sequence, threading: pre-arbitration grounded recall (WS3 T1); latent-space per-modality search; optional tensor inference; arbitration; execution (latent fast-path, procedure, or deliberation); episodic encoding; `CycleResponse` emission; WS3 T2 knowledge use→reinforce edge; tensor training submission; sensory prediction error routing. CANON enforcement throughout: read-only drive access, Theater Prohibition, Shrug Imperative, grounding provenance.

- **Exports:** `DecisionMakingService`, `enqueueTurn`, `processInput`, `getCognitiveContext`, `reportOutcome`, `startTickLoop`, `stopTickLoop`, `response$`, `getDocumentWriteBackDegradations`
- **Key constants:** `RECENT_GAP_TYPES_CAP=20`; `MAX_PENDING_LATENT=100`; `DEFAULT_TICK_MS=200`; `IDLE_PRESSURE_THRESHOLD=4.0`; `SELF_INITIATE_COOLDOWN_MS=10_000`; `SENSORY_TEXT_THRESHOLD=0.1`; `SENSORY_AUDIO_THRESHOLD=0.1`; `SENSORY_VIDEO_THRESHOLD=0.2`
- **Deps:** `ProcessInputService`, `ActionHandlerRegistryService`, `LatentSpaceService`, `WkgContextService`, `DeliberationService`, `SensoryPredictionService`, `ScenePredictionService`, `ModalityRegistryService`, `TickSamplerService`, `SensoryStreamLoggerService`, `AttractorMonitorService`, `MoodBleedMonitorService`, `CycleGuardService`
- **Gotchas:** Epoch fencing at lines 1697, 1720, 1857 (CRITICAL zombie-cycle guards). WS4 T5 person-scoping write-time logic (lines 1618–1631) discriminates verdict source, not ambient context — conservative-when-ambiguous rule. WS3 T2 reinforce must match both pre-arbitration `factNodeId` AND delivered `responseGroundingProvenance`. No-LLM degradation (lines 1524–1553) overrides `arbitrationType` to honest SHRUG. Latent fast-path gated on `arbitrationChoseLatent` to enforce arbitration authority. Text document-embedding degradation drops text modality rather than storing mislabeled QUERY embedding.

---

### decision-making.tokens.ts

**Role:** NestJS DI token definitions — one public symbol and 18 internal symbols.

`DECISION_MAKING_SERVICE` is the only public token (re-exported from `index.ts`). All others are marked INTERNAL and deliberately excluded from barrel export. JSDoc on each token documents its service interface, pipeline role, and consumption site.

- **Exports:** All 19 tokens listed (see interfaces file for token semantics)
- **Key constants:** `MAE > 0.30` (PREDICTION_PESSIMIST); `>20%` nodes without SENSOR/GUARDIAN provenance (HALLUCINATED_KNOWLEDGE); `>70%` prediction failures (PLANNING_RUNAWAY); event buffer flush: 10 events or 100 ms
- **Gotchas:** INTERNAL tokens must not be injected outside `DecisionMakingModule`. `TENSOR_INFERENCE_SERVICE` is externally provided by `CognitionModule`. `MOOD_BLEED_MONITOR_SERVICE` has zero write paths — observability only.

---

### deliberation/context-window.service.ts

**Role:** Token-aware context assembler for LLM calls within per-deliberation-step token budgets.

Manages priority-based truncation: system prompt, current input, conversation history (most-recent-first), generation reserve. Token estimation: `3.5 chars/token` + `MESSAGE_OVERHEAD_TOKENS=4` + `SYSTEM_PROMPT_OVERHEAD_TOKENS=8`. Per-step budget fractions: `INNER_MONOLOGUE=35%`, `CANDIDATE_GENERATION=60%`, `SELECTION=30%`, `DEBATE_FOR/AGAINST=30%`, `ARBITER=35%`. Individual messages capped at ~25% of remaining budget.

- **Exports:** `ContextWindowService`, `ContextAssemblyRequest`, `AssembledContext`, `DeliberationStep`
- **Key constants:** `CHARS_PER_TOKEN=3.5`; `MESSAGE_OVERHEAD_TOKENS=4`; `SYSTEM_PROMPT_OVERHEAD_TOKENS=8`; `DEFAULT_TOTAL_BUDGET=16384`; step fractions as above
- **Deps:** `@nestjs/common`, `@nestjs/config`, `@sylphie/shared`
- **Gotchas:** Token estimation overestimates deliberately (safe for context-window overflow). Messages can be truncated mid-content (line 379).

---

### deliberation/deliberation.service.ts

**Role:** Multi-step Type 2 reasoning pipeline — 5-step structured deliberation replacing single LLM calls.

Steps: (1) Inner Monologue (intent classification); (2) Candidate Generation (3 responses with tool access); (3) Deterministic Selection (scoring replaces LLM call); (4–5) conditional Debate + Arbiter synthesis if `confidence < 0.7` or novel situation. Implements WS3 T1 recall grounding, OKG vs WKG source discrimination (`groundedBy`). Handles LLM unavailability with `degradedNoLlm` flag and honest SHRUG. Exports numerous pure helper functions for grounding logic.

- **Exports:** `DeliberationService` + `DeliberationResult`, `DeliberationCandidate`, `DebateResult`, `ActionRequest`, `DeliberationTrace`, `isIgnoranceResponse`, `recallKeyForQuestion`, `getRecalledFactForRecall`, `okgRecallProvenance`, `applyOkgRecallGrounding`, `personFactRecalled`, `inferGrounding`, `discriminateGroundedBy`
- **Key constants:** `CANDIDATE_COUNT=3`; `DEBATE_THRESHOLD=0.7`; `STEP_MAX_TOKENS=200`; `DELIBERATION_TEMPERATURE=0.4`; `CANDIDATE_TEMPERATURE=0.7`; `NO_LLM_SHRUG_TEXT` literal; `CHATBOT_RE` and `IDK_RE` regexes
- **Deps:** `WkgContextService`, `ToolRegistryService`, `ContextWindowService`, `IEpisodicMemoryService`, `IDecisionEventLogger`, `IWorkingMemoryService`, `OllamaLlmService`
- **Gotchas:** Arbiter tag re-verification strips self-asserted GROUNDED tags unless backed by real provenance. Ignorance responses always degrade to UNKNOWN regardless of WKG context (Trap A guard). `scoreCandidate` penalizes chatbot phrases (`-0.5`), "I don't know" (`-0.7`), question-endings (`-0.15`). Legacy `applyOkgRecallGrounding` marked transitional — WS3 T1 pre-arbitration path owns OKG recall now.

---

### deliberation/recall-retrieval.spec.ts

**Role:** WS3 T1 test suite — pre-arbitration grounded recall retrieval and honesty guard.

Pins `retrieveRecallGrounding` (OKG attr-id or single-hop WKG node_id) and `applyRecallGroundingFromRetrieval` (C2 honesty guard — upgrades to GROUNDED only when fact value surfaces verbatim in response). Covers OKG hits, non-recall questions, unknowable recalls, WKG single-hop fallback, OKG precedence, passthrough when no personId, already-GROUNDED no-override.

- **Key constants (test):** `PERSON='user-jim'`; `KNOWN_FACTS=['name: Jim', 'location: Seattle', 'dog: Max']`
- **Gotchas:** Honesty guard uses case-insensitive substring match with minimum length 2 — single-letter facts fail even if semantically valid. Multi-hop traversal is deferred to WS3 Phase 3.

---

### deliberation/recall-retrieval.ts

**Role:** Pre-arbitration grounded recall retrieval — resolves provenance node IDs once before arbitration.

`retrieveOkgRecall()` resolves person self-facts using deterministic `attr-${personId}-${key}` node IDs. `retrieveWkgRecall()` finds a topical WKG entity (non-Drive/CoBeing/Word). `retrieveRecallGrounding()` returns a `RecallRetrieval` with node ID, fact value, source, and confidence. `applyRecallGroundingFromRetrieval()` applies the pre-resolved retrieval with honesty guard C2. OKG wins over topical WKG provenance. Multi-hop deferred to WS3 Phase 3.

- **Exports:** `RecallSource`, `RecallRetrieval`, `retrieveRecallGrounding`, `applyRecallGroundingFromRetrieval`
- **Key constants:** Minimum fact value length for OKG retrieval and honesty guard = 2; excluded WKG entity types: `['Drive', 'CoBeing', 'Word']`
- **Deps:** `./deliberation.service`, `../wkg/wkg-context.service`, `@sylphie/shared`

---

### deliberation/tools/tool-registry.ts

**Role:** MCP-style tool registry exposing internal Sylphie systems to the LLM deliberation engine as callable tools.

Constant `DELIBERATION_TOOLS` array defines 7 tools with JSON-schema parameters: `wkg_query`, `episodic_search`, `person_query`, `drive_state`, `web_search`, `conversation_history`, `research_entity`. `createExecutor()` dispatches tool names to private handlers. Provenance hierarchy: WKG (high trust), episodic (medium), web (low/consensus), LLM (lowest). `HIGH_FIDELITY_DOMAINS` list (13 domains).

- **Exports:** `DELIBERATION_TOOLS`, `ToolRegistryService`
- **Key constants:** 13 `HIGH_FIDELITY_DOMAINS`; episodic search cap 5; web search timeout 10 000 ms; conversation history max 30 / default 10; web results cap 8; drive pressure thresholds (Anxiety/Curiosity/Boredom/Social at 0.5; Guilt/Sadness at 0.3)
- **Deps:** `@nestjs/common`, `@nestjs/config`, `@sylphie/shared`, `@sylphie/drive-engine`, `WkgContextService`, `decision-making.tokens`
- **Gotchas:** `executeGoogleSearch` has dead code at line 404 (domain filter branch does nothing). `interpretDriveState` thresholds are hardcoded, not configurable. `episodicMemory` and `actionHandlerRegistry` are `@Optional` — `research_entity` fails silently if registry is null. No circuit breaker for SearXNG unreachability.

---

### episodic-memory/consolidation.service.ts

**Role:** Bridge between episodic memory and semantic WKG — identifies mature episodes for Learning subsystem handoff.

Eligibility: `age > 2 hours` AND `estimatedConfidence > 0.65`. Does NOT write to WKG — returns `SemanticConversion` records for Learning to persist. Confidence estimated from `ageWeight` and `encodingDepth` (DEEP: `min(1.0, ageWeight × 1.2)`; NORMAL: `ageWeight`; SHALLOW: `max(0.4, ageWeight × 0.8)`; SKIP: `0.0`). Entity extraction via title-cased token heuristics. All extracted content tagged `provenance='INFERENCE'`.

- **Exports:** `ConsolidationService`
- **Key constants:** `MIN_AGE_HOURS=2`; `MIN_CONFIDENCE_THRESHOLD=0.65`; `EXTRACTION_PROVENANCE='INFERENCE'`; DEEP confidence factor 1.2×; SHALLOW 0.8×; entity length threshold 2 chars; inputSummary subject truncation 80 chars; secondary relationship confidence multiplier 0.8
- **Deps:** `@nestjs/common`, `@sylphie/shared`

---

### episodic-memory/episodic-memory.service.ts

**Role:** In-process ring buffer episodic memory store (capacity 50).

`encode()` gates on `ENCODING_GATE_THRESHOLD=0.15` (not 0.60 as the inline comment says — empirically drives reach 0.15 after 2–3 min). `queryByContext()` uses Jaccard similarity on whitespace-tokenized context fingerprints, threshold `0.70`. Persists to TimescaleDB `episodic_memory_checkpoint` table across restarts. Emits `EPISODE_ENCODED` via optional `IDecisionEventLogger`. Episodes carry optional `speakerId`/`speakerIsGuardian` (WS4 T3).

- **Exports:** `EpisodicMemoryService`, `encode`, `getRecentEpisodes`, `queryByContext`, `getEpisodeCount`, `clear`
- **Key constants:** `RING_BUFFER_CAPACITY=50`; `ENCODING_GATE_THRESHOLD=0.15`; `CONTEXT_SIMILARITY_THRESHOLD=0.70`
- **Deps:** `@sylphie/shared`, `@nestjs/common`, `decision-making.interfaces`, `decision-making.tokens`
- **Gotchas:** Encoding gate comment at line 167 says 0.60 but actual const at line 61 is 0.15 (mismatch). SKIP depth overridden to SHALLOW if gate passes — caller's depth silently overridden. Ring buffer not thread-safe (JavaScript is single-threaded). `TimescaleService` and `IDecisionEventLogger` are `@Optional`.

---

### executor/executor-engine.service.ts

**Role:** FSM managing cognitive loop phases with timeout enforcement, cycle metrics, and error recovery.

Legal transition sequence: IDLE→CATEGORIZING→RETRIEVING→PREDICTING→ARBITRATING→EXECUTING→OBSERVING→LEARNING→IDLE. Illegal transitions log a warning but proceed anyway. Timeouts: `STATE_TIMEOUT_MS=500` (most states), `EXECUTING_TIMEOUT_MS=30_000` (Ollama invocation). Auto-recovers to IDLE on timeout. Tracks per-state and per-cycle latency. Emits to TimescaleDB via optional `IDecisionEventLogger`. `forceIdle()` is the only external recovery path.

- **Exports:** `ExecutorEngineService`
- **Key constants:** `STATE_TIMEOUT_MS=500`; `EXECUTING_TIMEOUT_MS=30_000`; full `VALID_TRANSITIONS` map
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `crypto`, `decision-making.interfaces`, `decision-making.tokens`
- **Gotchas:** Illegal transitions log but proceed — may mask bugs. `eventLogger` is `@Optional`; if null, no TimescaleDB events emitted. Cycle initialization happens on first transition out of IDLE, so IDLE itself never records metrics.

---

### graduation/type1-tracker.service.ts

**Role:** State machine for action procedure graduation from Type 2 (deliberative) to Type 1 (reflexive).

State sequence: UNCLASSIFIED → TYPE_2_ONLY → TYPE_1_CANDIDATE → TYPE_1_GRADUATED, with demotion path TYPE_1_GRADUATED → TYPE_1_DEMOTED → TYPE_2_ONLY. Uses pure imported `qualifiesForGraduation(confidence, recentMAE)` and `qualifiesForDemotion(recentMAE)` per CANON Standard 6 (no self-modification of evaluation). Rolling MAE window capped at `MAX_MAE_WINDOW=10`. Graduation: `confidence > 0.80 AND MAE < 0.10`; demotion: `MAE > 0.15`. In-process Map keyed by `procedureId` (no database persistence).

- **Exports:** `Type1TrackerService`, `buildPlaceholderSnapshot`
- **Key constants:** `MAX_MAE_WINDOW=10`; graduation/demotion thresholds implicit in shared pure functions; placeholder `tickNumber=-1`, `sessionId='type1-tracker'`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `decision-making.tokens`, `decision-making.interfaces`
- **Gotchas:** `GraduationRecords` Map is unbounded — `AttractorMonitorService` must alert on pathological growth. `buildPlaceholderSnapshot()` has all-zero pressure fields — used outside active cycle. Event emission failure caught and logged but not propagated.

---

### index.ts

**Role:** Public API barrel for the decision-making module.

Re-exports: `DecisionMakingModule`, `InboundTurn`, `CycleGuardService`, `QueuePositionSnapshot`, injection tokens (`DECISION_MAKING_SERVICE`, `ARBITRATION_SERVICE`, `ATTRACTOR_MONITOR_SERVICE`, `MOOD_BLEED_MONITOR_SERVICE`, `TENSOR_INFERENCE_SERVICE`, `EPISODIC_MEMORY_SERVICE`), service classes with their types, sensory pipeline encoders and services, WS3 T1 recall functions, and `WkgContextService`.

- **Gotchas:** Clean barrel with no stubs or TODOs. Backward-compat comment for sensory-pipeline re-exports (lines 74–75).

---

### interfaces/decision-making.interfaces.ts

**Role:** Interface contracts for the entire Decision Making subsystem.

Defines 13 service interfaces and 2 tensor inference types. Key numeric contracts: `RETRIEVAL_THRESHOLD=0.50`; ACT-R formula `min(1.0, base + 0.12 × ln(count) - d × ln(hours + 1))`; Type 1 graduation `{confidence: 0.80, MAE: 0.10}`; context similarity threshold `0.70`; consolidation `{age: 2h, confidence: 0.65}`; `ANXIETY_THRESHOLD=0.70`, `GUILT_THRESHOLD=0.50`; threshold clamp `[0.30, 0.70]`; guardian feedback weight `2×` confirmation / `3×` correction; tensor sidecar `port=8431`, `input_dim=1561`, `output_action_dim=32`, `timeout=50ms`; event buffer flush: 10 events or 100 ms.

- **Exports:** All 16 interface/type symbols (see tokens file for the full list)
- **Gotchas:** CANON §Shrug Imperative mandates SHRUG discriminated union — no low-confidence random selection possible. CANON §Theater Prohibition requires `CognitiveContext` to carry `DriveSnapshot`. Consolidation does NOT write to WKG — prepares for Learning handoff only. Tensor sidecar is fire-and-forget on training; gracefully degrades to null on timeout.

---

### inputs/encoders/audio.encoder.ts

**Role:** Encodes raw Opus/WebM audio chunks into fixed-dimension embedding vectors.

Extracts 16 statistical features from encoded bitstream bytes (presence, normalized size, byte-level energy/peak/variance, entropy, 8-bin histogram, zero-crossing rate, recency), then projects via Xavier-initialized `[EMBEDDING_DIM×16]` weight matrix (seed `0xa0d10`). Returns zero vector for empty chunks.

- **Exports:** `AudioEncoder`, `AudioChunk`
- **Key constants:** `FEATURE_DIM=16`; `AUDIO_PROJECTION_SEED=0xa0d10`; size normalization divisor `8192`; zero-crossing threshold `128`; recency scale factor `100`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `ModalityRegistryService`, `linear-algebra`
- **Gotchas:** Features operate on encoded bytes, not decoded PCM — statistical proxies for audio presence, not true audio analysis. `eventDriven` is hardcoded `false`.

---

### inputs/encoders/drive.encoder.ts

**Role:** Encodes 12-float drive pressure vector into embedding via z-score normalization + linear projection.

Xavier-initialized `[EMBEDDING_DIM×12]` weight matrix (seed `0xd41e`). Z-score normalization degrades gracefully to zeros when `std=0`. Registers with `ModalityRegistryService` on init.

- **Exports:** `DriveEncoder`
- **Key constants:** `DRIVE_VECTOR_SIZE=12`; `DRIVE_PROJECTION_SEED=0xd41e`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `ModalityRegistryService`, `linear-algebra`

---

### inputs/encoders/face.encoder.ts

**Role:** Encodes facial detection data (blendshapes, landmarks, bounding box) into 512-dimensional embeddings.

Extracts 20 features: face count, primary face bbox geometry, detection confidence, 6 blendshape group means, landmark centroid and spread, head pose proxies (yaw, pitch, roll via atan2). Projects via `[512×20]` Xavier matrix (seed `0xface0`).

- **Exports:** `FaceEncoder`
- **Key constants:** `FEATURE_DIM=20`; `FACE_PROJECTION_SEED=0xface0`; `FRAME_W=640`; `FRAME_H=480`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `ModalityRegistryService`, `linear-algebra module`
- **Gotchas:** Landmark indices (1, 159, 186, 234, 386, 454) are hardcoded to MediaPipe's specific indexing — silent breakage if MediaPipe changes. Guard `landmarks.length >= 455` required before head-pose access.

---

### inputs/encoders/index.ts

**Role:** Re-export barrel for multimodal input encoders (text, video, drive, audio).

- **Exports:** `TextEncoder`, `VideoEncoder`, `DriveEncoder`, `AudioEncoder`, `AudioChunk`
- **Gotchas:** Asymmetric prefix pattern (`search_query` vs `search_document`) is critical — both prefixed identically would collapse retrieval asymmetry and produce spurious cosine matches.

---

### inputs/encoders/scene.encoder.ts

**Role:** Encodes `SceneSnapshot` objects into 768-dimensional embeddings for the decision pipeline.

Extracts 35 features: 20-class COCO histogram, normalized counts (objects/persons/identified faces), primary-person bbox, mean confidence, scene stability, new/lost object counts, quadrant density (TL/TR/BL/BR). Projects via `[768×35]` Xavier matrix (seed `0x5ce0e`).

- **Exports:** `SceneEncoder`
- **Key constants:** `FEATURE_DIM=35`; `FRAME_W=640`; `FRAME_H=480`; `SCENE_PROJECTION_SEED=0x5ce0e`; 20 hardcoded COCO-like labels; normalization factors: object count `/20`, person count `/10`, identified faces `/5`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `ModalityRegistryService`, `linear-algebra`
- **Gotchas:** Scene stability formula: `1 - (changeCount / max(n, 1))` clamped to `[0,∞)` via `Math.max(0,...)`. Primary-person bbox selected by area, not confidence. `CLASS_INDEX` must stay in sync with `VideoEncoder` — no runtime check.

---

### inputs/encoders/text.encoder.ts

**Role:** Text input encoder — wraps Ollama embedding API with asymmetric query/document prefix handling.

Uses nomic-embed-text (768-dim). Prefixes: `search_query: ` for live inputs (QUERY side), `search_document: ` for stored patterns (DOCUMENT side). Hard timeout `DEFAULT_EMBED_TIMEOUT_MS=3000`, degrades to zero vector on failure. Implements `DocumentEncoder` interface discovered via `isDocumentEncoder()` type guard.

- **Exports:** `TextEncoder`, `DocumentEncoder`, `isDocumentEncoder`
- **Key constants:** `DEFAULT_EMBED_TIMEOUT_MS=3000`; `QUERY_PREFIX='search_query: '`; `DOCUMENT_PREFIX='search_document: '`
- **Deps:** `@nestjs/common`, `@nestjs/config`, `ollama`, `@sylphie/shared`
- **Gotchas:** Timeout leaves underlying Ollama embed promise to settle unobserved (no AbortSignal on Ollama client). Zero-vector degradation masks embedding failures in logs.

---

### inputs/encoders/video.encoder.ts

**Role:** Encodes YOLO video detections into fixed-dimensional embeddings via hand-crafted features.

26 features: 20-class COCO histogram (slots 0–19), detection count clamped via `/20` (slot 20), mean bbox center X/Y normalized to `640×480` (slots 21–22), mean bbox area fraction (slot 23), mean/max confidence (slots 24–25). Xavier weight matrix `[EMBEDDING_DIM×26]` (seed `0xa1de0`).

- **Exports:** `VideoEncoder`
- **Key constants:** 20 COCO classes; `FEATURE_DIM=26`; `VIDEO_PROJECTION_SEED=0xa1de0`; `FRAME_W=640`; `FRAME_H=480`; frame area `307200`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `ModalityRegistryService`, `linear-algebra`
- **Gotchas:** Unmatched detection classes are silently dropped. Confidence values (slots 24–25) are NOT clamped to `[0,1]`.

---

### inputs/fusion/sensory-fusion.ts

**Role:** Fuses multimodal sensory inputs into a unified embedding via concatenation + linear projection.

Concatenates all N modality embeddings, projects via Xavier-initialized `[d × N×d]` matrix (seed `0xf05e`). Projection matrix lazily initialized on first `fuse()` call. `skipNetworkEmbedding=true` substitutes zero embedding for network-bound modalities (currently only `'text'`) to avoid cycle stalls. Missing modalities contribute zero vectors.

- **Exports:** `SensoryFusionService`
- **Key constants:** `FUSION_PROJECTION_SEED=0xf05e`; `NETWORK_BOUND_MODALITIES=['text']`
- **Deps:** `@sylphie/shared`, `@nestjs/common`, `ModalityRegistryService`, `linearProject`, `xavierMatrix`
- **Gotchas:** `NETWORK_BOUND_MODALITIES` is hardcoded — extending requires code change. No error handling if `encoder.encode()` fails (no try/catch at line 109). Pass-through metadata not validated against a schema.

---

### inputs/index.ts

**Role:** Central export barrel for the decision-making inputs subsystem.

Re-exports `TextEncoder`, `VideoEncoder`, `DriveEncoder`, `SensoryFusionService`, `TickSamplerService`, `ModalityRegistryService`, `xavierMatrix`, `linearProject`.

---

### inputs/linear-algebra.ts

**Role:** Lightweight linear algebra utilities — Xavier-initialized weight matrices and matrix-vector projection.

`xavierMatrix(rows, cols, seed=42)` generates matrices via Xavier/Glorot uniform distribution `U(-limit, +limit)` where `limit = sqrt(6/(rows+cols))`, using deterministic `mulberry32` PRNG. `linearProject(W, x, b)` performs `y = Wx + b` via nested loops.

- **Exports:** `xavierMatrix`, `linearProject`
- **Key constants:** `limit = sqrt(6/(rows+cols))`; default seed `42`; PRNG range `[0,1)`; `4294967296 = 2^32`
- **Gotchas:** No input validation (array lengths, NaN, Infinity). `mulberry32` uses mutable closure state. Naive nested loops — not vectorized.

---

### inputs/registry/index.ts

**Role:** Re-export barrel for `ModalityRegistryService`.

---

### inputs/registry/modality-registry.service.ts

**Role:** Central registry for sensory modality encoders — dynamic registration and lookup.

Maintains `Map<string, ModalityEncoder>`. `register()` throws on duplicate. `getAll()` returns encoders sorted alphabetically. `getEventDrivenNames()` returns names where `eventDriven=true`. Encoders self-register during `onModuleInit`. No unregister/teardown method.

- **Exports:** `ModalityRegistryService`
- **Deps:** `@nestjs/common`, `@sylphie/shared`
- **Gotchas:** Registration is not idempotent. `getAll()` sorts alphabetically on every call. No concurrent-registration protection.

---

### inputs/sampling/tick-sampler.ts

**Role:** Tick-driven sensory frame production with rolling temporal context and EWMA embedding blending.

Maintains latest raw values per modality. On `sample()`: fuses via `SensoryFusionService`, blends with EWMA accumulator (`EWMA_ALPHA=0.3`, current 30%/history 70%), pushes to rolling window of `WINDOW_SIZE=30` frames, clears event-driven modalities, emits on `frames$` Subject. `injectSyntheticText()` sets text without triggering event callbacks (autonomous processing). `recordInputArrival()` updates `lastInputAt` without firing callbacks (WS4 T2 gateway path).

- **Exports:** `TickSamplerService`
- **Key constants:** `WINDOW_SIZE=30`; `EWMA_ALPHA=0.3`
- **Deps:** `@sylphie/shared`, `SensoryFusionService`, `ModalityRegistryService`
- **Gotchas:** `peek()` calls `sample()` if window is empty — triggers full frame production. `recordInputArrival()` is a WS4 T2 workaround for gateway intake paths. No handling for blended embedding dimensionality mismatch.

---

### latent-space/latent-space.service.ts

**Role:** Per-modality pattern store for Type 1 reflexes — hot/warm/cold three-layer cosine similarity search.

Hot layer (in-memory, `MAX_HOT_ENTRIES=6000`), warm layer (pgvector/TimescaleDB), cold layer (WKG). Boots by hydrating hot from warm (frequency-weighted). `searchByModality()`: enforces `MIN_MODALITY_POPULATION=3` gate (single fresh pattern rejected when below floor), `MIN_TRUSTED_USECOUNT=3`, `RUNNER_UP_MARGIN=0.05`. `searchMultiModal()` requires text match; combines per-modality scores via `MODALITY_WEIGHTS`. Write pipeline: hot-layer immediate, warm-layer async fire-and-forget INSERT. Schema: `learned_patterns` table with `vector(EMBEDDING_DIM)`, ivfflat index. `applyPersonScopeDemotion()` demotes GROUNDED→UNKNOWN when `groundingPersonId ≠ currentPersonId`.

- **Exports:** `LatentSpaceService`, `LearnedPattern`, `LatentMatch`, `MultiModalLatentMatch`, `NewPattern`, `MultiModalWriteOpts`, `applyPersonScopeDemotion`
- **Key constants:** `MAX_HOT_ENTRIES=6000`; `DEFAULT_SIMILARITY_THRESHOLD=0.80`; `RUNNER_UP_MARGIN=0.05`; `MIN_MODALITY_POPULATION=3`; `MIN_TRUSTED_USECOUNT=3`; `MODALITY_WEIGHTS={text:0.50, audio:0.25, video:0.25, faces:0.15, drives:0.10}`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `crypto`, `./vector-math`
- **Gotchas:** `searchMultiModal` rejects audio/video/drives-only (requires text). Warm-layer writes are fire-and-forget — SQL failures logged but not surfaced. `hotEntryToPattern()` reconstructs with placeholder values. Person-scope demotion is a pure function exported for `decision-making.service` to call externally.

---

### latent-space/min-population-gate.spec.ts

**Role:** Regression test suite for the min-population trust gate (WS1 follow-up #3).

Verifies: single fresh pattern (`useCount=0`) rejected despite high cosine similarity when population < 3; multi-modal routes to deliberation when no trusted text match; pattern with `useCount≥3` fires even alone; once population reaches 3, runner-up margin discriminates over-general patterns.

- **Key constants (test):** `DEFAULT_SIMILARITY_THRESHOLD=0.80`, `MIN_MODALITY_POPULATION=3`, `MIN_TRUSTED_USECOUNT=3`, `RUNNER_UP_MARGIN=0.05`

---

### latent-space/okg-fact-tier.spec.ts

**Role:** Tests `deriveOkgFactTier` from `@sylphie/shared` — OKG self-fact Std-3 confidence ceiling and Std-5 identity-blind guardrail.

Matrix: guardian+self_reported → `{confidence:0.9, provenanceType:'GUARDIAN'}`; non-guardian self-report / observed / inferred → `{confidence:0.6, ...}`. Only guardian+self_reported can exceed the 0.60 ceiling.

- **Key constants:** `0.9`, `0.6`, Std-3, Std-5

---

### latent-space/person-scope-replay.spec.ts

**Role:** Tests person-scope replay isolation (WS4 T5 §3.2/§6 A4) — privacy gate for Type 1 grounded patterns.

Pins: GROUNDED patterns scoped to person A must not replay as GROUNDED to person B; world-scoped (null) patterns may replay to anyone; honest re-grounding from current speaker's own OKG can upgrade demoted UNKNOWN back to GROUNDED. Critical regression for §3.1 write predicate bug where ambient WKG context could flip OKG facts to world-scope.

- **Key constants (test):** `PERSON_A='personA'`; `PERSON_B='personB'`; `confidence=0.6`/`0.9`
- **Gotchas:** THE BUG (lines 160–166): old code re-derived WKG backing from ambient context, leaking person A's private OKG facts when an unrelated topical entity happened to be in context. `discriminateGroundedBy` reads SOURCE from the winning cascade rule (OKG recall precedence over topical WKG) to prevent this flip. Test at lines 188–202 is the live-verified failure case.

---

### latent-space/vector-math.ts

**Role:** Shared vector mathematics utilities — cosine similarity and pgvector embedding parsing.

`cosineSimilarity(a, b)` operates on minimum vector length. Returns 0 on zero-denominator. `parseEmbedding(text)` parses pgvector text format `[0.1,0.2,...]` into `number[]`.

- **Exports:** `cosineSimilarity`, `parseEmbedding`
- **Gotchas:** Silently truncates to minimum vector length on mismatch. `parseEmbedding` returns `[]` for both empty and malformed input.

---

### llm/ollama-llm.service.ts

**Role:** Hybrid LLM service — local Ollama (quick/medium tiers) and DeepSeek API (deep tier) with circuit breaker.

`complete()` routes by tier. `completeWithTools()` loops up to `MAX_TOOL_ROUNDS=5` (Ollama only). Circuit breaker trips after `CIRCUIT_BREAKER_THRESHOLD=5` consecutive failures, setting `isAvailable()=false` for the Lesion Test. Cost tracking for Drive Engine cognitive effort pressure. DeepSeek cost: `$0.28/$0.42` per million input/output tokens.

- **Exports:** `OllamaLlmService`, `ToolDefinition`, `ToolExecutor`
- **Key constants:** `TOKENS_PER_WORD=1.3`; `COMPLETION_UTILIZATION=0.5`; `MS_PER_TOKEN=15`; `EFFORT_PER_1K_TOKENS=0.05`; `DEEPSEEK_INPUT_COST_PER_M=0.28`; `DEEPSEEK_OUTPUT_COST_PER_M=0.42`; `CIRCUIT_BREAKER_THRESHOLD=5`; `MAX_TOOL_ROUNDS=5`
- **Deps:** `@nestjs/common`, `@nestjs/config`, `ollama`, `@sylphie/shared`
- **Gotchas:** Tool calling is Ollama-only; DeepSeek tool calls not implemented. Circuit breaker never auto-resets — requires explicit `resetCircuitBreaker()`. DeepSeek reasoning models extract from `message.content` OR `message.reasoning_content` (fallback logic). `AbortSignal.timeout()` on fetch has no version check.

---

### logging/decision-event-logger.service.spec.ts

**Role:** Unit tests for `DecisionEventLoggerService` batch INSERT and flush behavior.

Verifies: 3 events → single INSERT with 27 params (9 cols × 3 rows) and sequential placeholders (`$1–$27`); empty buffer → no query; query failure → single error log with count + type names; SQL placeholder numbering correct across rows. Uses `STUB_DRIVE_SNAPSHOT` fixture with all 12 drive dimensions.

- **Key constants (test):** `BATCH_SIZE=10`, `FLUSH_INTERVAL_MS=100`, 9 columns per row, subsystem literal `'DECISION_MAKING'`
- **Gotchas:** Spy on `(service as any).logger` is brittle to refactoring. Timeout-based flush not exercised (only manual `flush()` calls). Payload JSON serialization not verified, only `params.length`.

---

### logging/decision-event-logger.service.ts

**Role:** Unified decision event logging with batched writes to TimescaleDB.

Buffers `BufferedEvent[]`, flushes when `BATCH_SIZE=10` events or `FLUSH_INTERVAL_MS=100ms` elapses. Builds parameterized multi-row INSERT (9 columns/row: id, type, timestamp, subsystem=`'DECISION_MAKING'`, session_id, drive_snapshot as JSON, payload as JSON, correlation_id, schema_version=1). Fire-and-forget — no await in `log()`. `onModuleDestroy()` flushes remaining buffer. Batch failure is atomic (all-or-nothing, no retry, no dead-letter queue).

- **Exports:** `DecisionEventLoggerService`
- **Key constants:** `BATCH_SIZE=10`; `FLUSH_INTERVAL_MS=100`; `schema_version=1`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `crypto`, `decision-making.interfaces`
- **Gotchas:** Flush timer resets on every `log()` call — continuous inflow may prevent timely flush. `TimescaleService` unavailability silently discards events after warn-level log.

---

### logging/sensory-stream-logger.service.ts

**Role:** Persists sampled sensory frames and events to TimescaleDB with pgvector indexing and audit trail.

Creates three tables on init: `sensory_ticks` (hypertable, `vector(768)`, ivfflat index `lists=100`), `events` (decision/communication log), `voice_patterns` (TTS cache). `logFrame()` writes async fire-and-forget. `querySimilar()` performs ANN search via pgvector `<=>` cosine operator. `schemaReady` flag gates all writes.

- **Exports:** `SensoryStreamLoggerService`
- **Key constants:** `EMBEDDING_DIM=768`; `ivfflat lists=100`; `similarity_default_limit=5`
- **Deps:** `@nestjs/common`, `@sylphie/shared`
- **Gotchas:** `logFrame` swallows all errors silently. `voice_patterns` table is created but no methods in this service write to or query it (dead code / future feature). Single `schemaReady=false` failure disables all logging for service lifetime (no retry). Comment flags `lists=100` tuning as needing attention at >1M rows.

---

### monitoring/attractor-monitor.service.ts

**Role:** Monitors five CANON-defined pathological attractor states and alerts when thresholds exceed.

Detectors with rolling windows: (1) `TYPE_2_ADDICT` (>0.90 LLM ratio over 50 arbitrations); (2) `HALLUCINATED_KNOWLEDGE` (>0.20 untrusted WKG provenance, 30-s Neo4j cache); (3) `DEPRESSIVE_ATTRACTOR` (composite shrug rate >0.50, MAE >0.25, Sadness/Anxiety >0.60); (4) `PLANNING_RUNAWAY` (>0.70 prediction failure ratio); (5) `PREDICTION_PESSIMIST` (MAE >0.30 when `totalPredictions < 100` cold-start guard). Emits `ATTRACTOR_STATE_ALERT` events. No write paths to Drive Engine per CANON.

- **Exports:** `AttractorMonitorService`, `DetectorResult`
- **Key constants:** All 14 threshold constants as documented
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `@sylphie/drive-engine`
- **Gotchas:** `PLANNING_RUNAWAY` lacks plan-proliferation integration (line 531: "requires Planning module integration which is not yet wired"). `HALLUCINATED_KNOWLEDGE` returns safe fallback on Neo4j failure. Rolling windows not persisted across restarts.

---

### monitoring/mood-bleed-monitor.service.spec.ts

**Role:** Unit test suite for `MoodBleedMonitorService` — 9 behavioral fixtures for WS4 Ticket 8.

Tests: (1) hostile speaker fires CRITICAL after 12 turns; (2) sad guardian venting does NOT fire (load-bearing T3 — sadness-only exclusion); (3) 5 turns below floor → no alert; (4) ambient baseline drift absorbed by EWMA → no alert; (5) shared distressing topic (equal contrast) → no alert; (6) hysteresis FSM (emit, cooldown, re-emit, deactivation); (7) guardian cap at WARNING; (8) tick-0 / tick regression / session change → silent discard; (9) self-cycle exclusion from speaker ledgers.

- **Key constants (test):** `CONTRAST_THRESHOLD=0.05`; `DEACTIVATION_THRESHOLD_FACTOR=0.7`; `COOLDOWN=600_000ms`; `MIN_OTHERS_ENTRIES=5`; `SETTLE_TICKS` ≥ `endSnap+2`; 20-turn rolling window; guardian sadness cap `0.70`
- **Gotchas:** Test 6 hysteresis is heavily commented with uncertainty about exact FSM transitions — falls back to "no extra alerts" assertions. Test 2 sadness cap is hardcoded `0.70` (not a shared constant). No assertions on internal window state, only on emitted alerts.

---

### monitoring/mood-bleed-monitor.service.ts

**Role:** Detects HOSTILE_INTERLOCUTOR_MOOD_BLEED — single speakers disproportionately elevating Sylphie's negative affect.

Four trigger gates: T1 min 10 turns per speaker; T2 contrast `μ_X − max(μ_others, 0) ≥ 0.05`; T3 multi-drive composition (≥2 of Anxiety/Sadness/Guilt > 0.01, sadness-only never qualifies); T4 global negative-affect `≥0.40` (WARNING), `≥0.60` (CRITICAL). All four must pass. Hysteresis FSM: INACTIVE → PENDING → ACTIVE, requiring 2 consecutive evals above threshold. 10-min re-alert cooldown. Deactivation at `0.7×` threshold. Baseline EWMA updated idle-only (half-life 300 ticks). Per-speaker rolling window of 20 closed brackets, LRU-evicted beyond 32 speakers. Zero write paths.

- **Exports:** `MoodBleedMonitorService`
- **Key constants:** All 16 service constants as documented; `ewmaAlpha≈0.00231`
- **Deps:** `@nestjs/common`, `rxjs`, `@sylphie/shared`, `@sylphie/drive-engine`
- **Gotchas:** Tick regression handling (line 296) references `this._lastTickNumber` declared at line 328 — relies on private field initialization at `-1`. Exception isolation in `onSnapshot()` swallows errors silently. T3 gate (sadness-only veto) is intentional but constrains alert scope. Guardian exemption caps severity at WARNING permanently.

---

### prediction/prediction.service.spec.ts

**Role:** Unit tests for `PredictionService` — generation, evaluation, lookup, and pruning.

Tests: prediction generation with `confidence × 0.8` discount; MAE evaluation across union of predicted/actual keys; `getActivePredictionIdForAction` linear search; `pruneStale` by age cutoff; MAE window caps at 10. One test uses `setTimeout(5)` then `pruneStale(1)` — timing-dependent.

- **Key constants (test):** `ACCURATE_MAE_THRESHOLD=0.10`, `PREDICTION_CONFIDENCE_DISCOUNT=0.8`, `MAE_HISTORY_MAX=10`, `RANDOM_DELTA_BOUND=0.1`

---

### prediction/prediction.service.ts

**Role:** Drive-effect prediction generation and evaluation for dual-process cognition.

Generates predictions for top N candidates (default 3), estimating drive effects from historical episode deltas matched by procedure ID/name, or random core-drive deltas `[-0.1, 0.1]` if no history. `evaluatePrediction()` computes MAE across all predicted and actual drive keys (missing values = 0). Rolling 10-MAE window per action feeds Type 1 tracker graduation/demotion logic. Stale unevaluated predictions pruned via `pruneStale(maxAgeMs)` at cycle start.

- **Exports:** `PredictionService`
- **Key constants:** `MAE_HISTORY_MAX=10`; `PREDICTION_CONFIDENCE_DISCOUNT=0.8`; `ACCURATE_MAE_THRESHOLD=0.10`; `RANDOM_DELTA_BOUND=0.1`
- **Deps:** `@sylphie/shared`, `@nestjs/common`, `crypto`, `decision-making.interfaces`, `decision-making.tokens`

---

### prediction/scene-prediction.service.ts

**Role:** Predicts scene state (expected objects in next frame) and generates per-object surprise errors routing to drives.

Maintains `Map<trackId, PredictedObject>`. On first frame (cold-start after `reset()`): initialize from confirmed objects, return zero surprise. Subsequent frames: flag missing, novel, and moved objects. Movement: normalized centroid distance, magnitude capped at 1.0 when `> 0.5` frame widths. `totalSurprise = sum(magnitudes) / confirmedCount`, capped 1.0. `reset()` is the determinism mechanism for hermetic gate runs (WS5 T0.7).

- **Exports:** `ScenePredictionService`, `SceneObjectError`, `ScenePredictionResult`
- **Key constants:** `MOVEMENT_THRESHOLD=0.15`; `FRAME_W=640`; `FRAME_H=480`; `normalization_divisor=0.5`
- **Deps:** `@nestjs/common`, `@sylphie/shared`
- **Gotchas:** First call after `reset()` returns surprise 0 by construction. Movement magnitude `> 0.5` frame-widths reports as magnitude 1.0. Persistence model is "simple" — trajectory extrapolation expected in future.

---

### prediction/sensory-prediction.service.ts

**Role:** Per-modality prediction error detection — tracks embeddings across frames via cosine distance.

EWMA-smoothed previous embedding (`EWMA_ALPHA=0.3`). Cosine distance `(1 - similarity)` in `[0, 2]`. First-frame returns `0.5`; new modalities return `1.0`. Errors below `NOISE_FLOOR=0.02` suppressed to 0. State resets via `reset()`.

- **Exports:** `SensoryPredictionService`
- **Key constants:** `EWMA_ALPHA=0.3`; `NOISE_FLOOR=0.02`
- **Deps:** `cosineSimilarity from ../latent-space/vector-math`, `@nestjs/common`
- **Gotchas:** No error handling for mismatched embedding dimensions — copies current wholesale (line 84). Disappearing modalities remain in `previousEmbeddings` indefinitely.

---

### process-input/process-input.service.ts

**Role:** Routes `SensoryFrame` through CATEGORIZING and RETRIEVING states to produce ranked action candidates.

8-step pipeline: (1) categorize by active modalities (GUARDIAN_FEEDBACK, DRIVE_SENSOR_TRIGGER, MULTIMODAL_INPUT, TEXT_INPUT, VOICE_INPUT, VISUAL_INPUT, UNKNOWN); (2) extract entities; (3) generate one-line summary; (4) find dominant drive; (5) SHA-256 context fingerprint from first 64 embedding values + category + drive; (6) query episodic memory (3 episodes); (6b) resolve nomic QUERY embedding, preferring `frame.modality_embeddings.text`; (7) retrieve WKG candidates; (8) rank Type-1-first then by confidence, slice to `INNER_MONOLOGUE_CAPACITY=5`. Normalizes `frame.raw.text` (plain string vs `{ content?, guardianFeedback? }`).

- **Exports:** `ProcessInputService`, `InputCategory`, `ProcessInputResult`
- **Key constants:** `INNER_MONOLOGUE_CAPACITY=5`; `DEFAULT_RECENT_EPISODES_FOR_CONTEXT=3`; embedding quantization 2 decimals; video detection confidence threshold `0.5`; entity word length minimum 3 chars
- **Deps:** `@nestjs/common`, `crypto`, `@sylphie/shared`, `decision-making.interfaces`, `decision-making.tokens`, `modality-registry.service`
- **Gotchas:** `resolveQueryEmbedding` returns null if both frame embedding and encoder unavailable — WKG cosine fails closed (`0.0`). Three optional dependencies degrade gracefully in lesion configs.

---

### shrug/shrug-imperative.service.ts

**Role:** Enforces CANON Immutable Standard 4 (Shrug Imperative) — prevents superstitious behavior by signaling incomprehension rather than random selection.

`shouldShrug()` checks if no candidates clear threshold. `classifyGapTypes()` labels gap as `MISSING_CONTEXT` or `LOW_CONFIDENCE`. `createShrugResult()` builds full SHRUG `ArbitrationResult` with `ShrugDetail`. Accumulates `shrugCount` and `totalCandidatesRejected` metrics.

- **Exports:** `ShrugImperativeService`, `ShrugMetrics`
- **Key constants:** Confidence formatted to 3 decimal places in reason strings
- **Deps:** `@sylphie/shared`
- **Gotchas:** `classifyGapTypes` accepts but ignores threshold parameter ("for API symmetry and future use"). `createShrugResult()` does not re-validate — caller is responsible for threshold check.

---

### threshold/threshold-computation.service.ts

**Role:** Dynamic action threshold computation based on current drive state.

Multiplicative formula: `baseThreshold=0.50` × `anxietyMultiplier` (up to 1.3 when anxiety > 0.3) × `moralMultiplier` (up to 1.2 when guilt > 0.3) × `curiosityReduction` (−0.2 when both curiosity > 0.4 and boredom > 0.3). Result clamped to `[0.30, 0.70]`.

- **Exports:** `ThresholdComputationService`
- **Key constants:** All 14 threshold/multiplier constants as documented
- **Deps:** `@nestjs/common`, `@sylphie/shared`
- **Gotchas:** File header notes "copied nearly verbatim from sylphie-old." No guards against invalid drive snapshot structure or out-of-range pressure values.

---

### wkg/reinforce-fact-node.spec.ts

**Role:** Unit test spec for `WkgContextService.reinforceFactNode()` and its call-site guard (WS3 T2).

Asserts: OKG reinforce writes to Neo4j OTHER on `(:Attribute {attr_id})`; WKG reinforce writes to Neo4j WORLD on `({node_id})`; 0.60 confidence ceiling never breached (ACT-R: `0.30 + 0.12×ln(count)`); nodes above 0.60 never demoted (retrieval_count still advances); missing nodes return null; Neo4j unavailability returns null. 20-iteration monotonic compounding test. Call-site guard `shouldReinforce` requires `grounding === 'GROUNDED'` AND non-empty provenance AND `recalledNodeId === provenance`.

- **Key constants (test):** `CONFIDENCE_THRESHOLDS.ceiling=0.60`; ACT-R formula `0.30 + 0.12×ln(count)`
- **Gotchas:** "No-reinforce-when-not-grounded" and "idempotent-per-turn" are enforced at the call site in `decision-making.service.ts`, not inside `reinforceFactNode()`.

---

### wkg/wkg-context.service.ts

**Role:** Central read/write interface to the World Knowledge Graph.

Read: assembles `WkgContext` for a frame by extracting entity names (90+ stopwords filtered, capitalized-only heuristic), fuzzy full-text matching via `kg_label_fulltext` Lucene index (fallback to CONTAINS), pulling 1-hop neighborhoods, finding relevant `ActionProcedure` nodes. Write: persists entities, relationships, procedures with provenance/confidence. `reinforceFactNode()` (WS3 T2): increments `retrieval_count`, recomputes confidence via shared pure `computeConfidence()`, capped at `CONFIDENCE_THRESHOLDS.ceiling=0.60` (CANON Standard 3), never demoting stronger nodes. Graph isolation: OKG Attribute nodes → Neo4j OTHER; WKG facts → Neo4j WORLD. `writeActionProcedure()` deduplicates via Jaccard similarity > 0.70 on trigger tokens, boosts existing confidence by +0.05 (cap 1.0).

- **Exports:** `WkgContextService`, `WkgEntity`, `WkgRelationship`, `WkgFact`, `WkgContext`, `NewEntity`, `NewRelationship`, `NewProcedure`
- **Key constants:** `CONFIDENCE_THRESHOLDS.ceiling=0.60` (CANON Standard 3 hard invariant); Jaccard dedup threshold `0.70`; procedure confidence boost `+0.05`; minimum confidence filter `0.30`; 90+ stopwords filtered
- **Deps:** `@sylphie/shared`, `@nestjs/common`, `TextEncoder`, `RecallSource`
- **Gotchas:** `writeEntity()` uses APOC dynamic-label creation with silent fallback to no-label MERGE if APOC unavailable. `embedTriggerPhrase` returns null on zero-vector (fail-closed cosine=0.0 downstream). `getBaseContext` fallback loads only Drive/CoBeing nodes — minimal context. `reinforce_at`/`reinforced_at` fields written but never decayed (no scheduling tie-in). Procedure dedup Jaccard threshold `0.70` is arbitrary.

---

### working-memory/activation.ts

**Role:** Pure deterministic activation scoring for working memory — ACT-R and spreading activation model.

Provides: `tokenize`, `jaccardSimilarity`, `extractEntityNames`, `estimateTokens` (3.5 chars/token), `computeRelevanceScore` (Jaccard + entity overlap clamped to [0,1]), `computeRecencyScore` (exponential decay `exp(-0.10 × hoursSince)`), `computeDriveModulation` (max pressure among associated drives), `computeActivation` (composite weighted sum clamped to [0,1]), `spreadActivation` (BFS, MAX accumulation, hop decay `0.60`, budget ceiling), `buildAdjacencyMap` (WKG relationships → bidirectional label map).

- **Exports:** All functions and constants documented (17 exported items)
- **Key constants:** `INITIAL_BOOST=0.20`; `HOP_DECAY_FACTOR=0.60`; `MAX_PROPAGATION_DEPTH=2`; `ACTIVATION_BUDGET=30`; `MIN_ACTIVATION_THRESHOLD=0.01`; `RECENCY_DECAY_RATE=0.10`; `MAX_SPREADING_BOOST=0.20`; weights `W_RELEVANCE=0.40`, `W_CONFIDENCE=0.20`, `W_RECENCY=0.20`, `W_DRIVE=0.20`; `MAX_SLOT_COUNT=40`; `DEFAULT_TOKEN_BUDGET=1500`; `CHARS_PER_TOKEN=3.5`
- **Deps:** `@sylphie/shared (PressureVector)`
- **Gotchas:** `spreadActivation` uses MAX accumulation — not sum; prevents unbounded cascade. Adjacency map requires external ID-to-label mapping; silently skips relationships with missing IDs. Drive modulation casts pressureVector via `unknown` to bypass strict typing. All functions are pure/deterministic — no side effects.

---

### working-memory/working-memory.service.ts

**Role:** Activation-driven context buffer selecting knowledge items for deliberation under capacity and token constraints.

5-source candidate collection: WKG facts, WKG entities, procedures, episodes, active drives, scene description. Composite activation scoring (relevance, confidence, recency, drive modulation, spreading activation). `MAX_SLOT_COUNT=16` slots under `DEFAULT_TOKEN_BUDGET=2048`. Minimum source guarantees: WKG_FACT 2, EPISODE 1, DRIVE 1, SCENE 1. 3-phase selection: fill minimums, fill by global rank, prune if over budget. Hot layer (`residualActivation` Map): persists entity activation across cycles with `RESIDUAL_DECAY=0.80`/cycle, `RESIDUAL_TTL_MS=30_000ms`. `buildSnapshot()` formats items with source tags for LLM system prompt injection.

- **Exports:** `WorkingMemoryService`
- **Key constants:** `MIN_SOURCE_SLOTS: {WKG_FACT:2, EPISODE:1, DRIVE:1, SCENE:1}`; `RESIDUAL_DECAY=0.80`; `RESIDUAL_TTL_MS=30_000`; `SOURCE_PRIORITY: {WKG_FACT:6, WKG_ENTITY:5, PROCEDURE:4, EPISODE:3, DRIVE:2, SCENE:1}`; `MAX_SLOT_COUNT=16`; `DEFAULT_TOKEN_BUDGET=2048`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `./activation`, `../wkg/wkg-context.service`, `../interfaces/decision-making.interfaces`
- **Gotchas:** `residualActivation` is ephemeral in-process — not persisted. Adjacency map rebuilt from scratch each cycle (potential performance concern for large WKG). Episode-drive association uses hardcoded threshold `0.3`. Residual MAX accumulation: strong old activation can outweigh weaker current until decay. `formatSummary` injects "NOT yours to claim" LLM directives — compliance depends on model.

---

## Cross-cutting Notes

### Risks / Stubs / TODOs

- **`RESEARCH_ENTITY` handler** writes `confidence=0.30` nodes to WKG from web search via SearXNG. JSON parsing of LLM extraction response fails silently on malformed output (`action-handlers/action-handler-registry.service.ts`).
- **`driveRelevanceScore` is always `0.0`** in `ActionRetrieverService` — the `W_DRIVE=0.20` scoring weight contributes nothing until procedures carry drive effects again.
- **`SensoryStreamLoggerService` `voice_patterns` table** is created but never written to or queried within the service itself — dead code or awaiting future feature.
- **`PLANNING_RUNAWAY` attractor detector** lacks plan-proliferation integration (comment at line 531: "requires Planning module integration which is not yet wired") — only checks failure ratio.
- **`ConsolidationService` `reinforce_at`/`reinforced_at` fields** are written but never read or decayed — no scheduling tie-in.
- **`ContradictionScannerService`** has no retry on Neo4j query failure and no integration with heavy contradiction resolution (deferred to Learning subsystem).
- **Episodic memory encoding gate** comment at line 167 says `0.60` but actual constant at line 61 is `0.15` — stale comment in `episodic-memory.service.ts`.
- **`ToolRegistryService` `executeGoogleSearch`** has dead code at line 404 (domain filter branch does nothing). `research_entity` result extraction lacks type safety.
- **`ThresholdComputationService`** is noted as "copied nearly verbatim from sylphie-old" — no guards against out-of-range drive snapshot values.
- **`Type1TrackerService` `GraduationRecords` Map** is unbounded for service lifetime — `AttractorMonitorService` must alert on pathological growth.
- **`WkgContextService` `writeEntity()`** uses APOC for dynamic-label creation with silent fallback to no-label MERGE if APOC is unavailable.
- **`LatentSpaceService` warm-layer writes** are fire-and-forget — SQL failures logged but not surfaced; no retry or dead-letter queue.
- **`DecisionEventLoggerService`** has no retry and no dead-letter queue — batch failure is atomic discard.
- **Tokenless legacy default** (`userId='guardian'`, `isGuardian=true`) in `InboundTurn` is preserved for backward compat; Ticket 4 will flip to guest default.
- **`CycleGuardService` line 525–526**: silent turn drop if `cycleRunner` not registered (logged error only).
- **`ConfidenceUpdaterService` event emission** is deferred — methods log debug but do not actually emit events without a `DriveSnapshot`; executor is responsible for correlation.
- **Working memory `formatSummary`** injects "NOT yours to claim" LLM prompt directives — compliance depends on the model actually respecting injected instructions.

### Entry Points and Hot Paths

- **Primary entry point:** `DecisionMakingService.enqueueTurn()` — all external callers (Communication gateway) enter here. Self-ticks enter via the internal timer loop.
- **Hot path:** `CycleGuardService` → `DecisionMakingService.processInput()` → `ProcessInputService` → `ActionRetrieverService` → `ArbitrationService` → (Type 1: `LatentSpaceService` fast-path + `ActionHandlerRegistryService`) | (Type 2: `DeliberationService` 5-step pipeline) → `EpisodicMemoryService.encode()` → `CycleResponse` emission.
- **Grounding provenance chain:** `recall-retrieval.ts:retrieveRecallGrounding()` (pre-arbitration, single-hop) → `DeliberationService:inferGrounding()` → `applyRecallGroundingFromRetrieval()` (C2 honesty guard) → `WkgContextService.reinforceFactNode()` (WS3 T2, post-delivery).
- **Sensory pipeline:** `TickSamplerService.sample()` → `SensoryFusionService.fuse()` → `DecisionMakingService.processInput()`.
- **Concurrency guard:** `CycleGuardService` is the serialization boundary; its `queuePositionUpdates$` observable is the only cross-subsystem channel into Communication without going through TimescaleDB.
- **Public module API:** `index.ts` barrel + `DecisionMakingModule` NestJS module. Only `DECISION_MAKING_SERVICE` token is publicly importable; all other 18 tokens are INTERNAL.

---

## Change Log

- 2026-06-13 — Initial auto-generated map (61 files read in full).
