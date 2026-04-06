# Decision Making — Missing Connections

**Date:** 2026-04-06
**Status:** Post-migration from sylphie-old architecture
**Scope:** Gaps at the boundaries where Decision Making connects to other subsystems

The 8-state FSM executor engine and all internal decision-making logic are fully implemented and compile clean. This document tracks what's NOT connected yet — the plumbing between Decision Making and the subsystems it depends on or feeds into.

---

## 1. Communication Subsystem (does not exist yet)

The architecture diagram shows Communication handling Input Parsing, Text output (TTS + Chatbox), and Other Evaluation (person modeling). None of this exists.

### 1.1 Response delivery to the client

**Where it breaks:** `DecisionMakingService.processInput()` runs the full 8-state cycle and the `LLM_GENERATE` handler produces text via Ollama, but the result sits in `executionResults` inside the method and is never sent anywhere.

**What's needed:** After the EXECUTING state produces a response, something must:
- Take the generated text from `executionResults`
- Send it back to the WebSocket client via ConversationGateway
- Optionally synthesize TTS audio via TtsService
- Record it as a `RESPONSE_DELIVERED` event in TimescaleDB

**Files involved:**
- `packages/decision-making/src/decision-making.service.ts` — has the execution results
- `apps/sylphie/src/gateways/conversation.gateway.ts` — has the WebSocket client reference
- `apps/sylphie/src/services/tts.service.ts` — has TTS capability

**Design question:** Should the executor emit the response via an event/observable that the gateway subscribes to? Or should the gateway call `processInput()` and get a response back? The architecture diagram suggests the former — System Reacts is a separate node from the executor.

### 1.2 `reportOutcome()` is never called

**Where it breaks:** `IDecisionMakingService.reportOutcome(actionId, outcome)` exists and correctly updates confidence + forwards to the Drive Engine, but nothing in the system calls it.

**What's needed:** After a response is delivered and the guardian reacts (confirms, corrects, or says nothing within a window), Communication should call `reportOutcome()` with:
- The action ID that produced the response
- Whether the prediction was accurate (did the action achieve its intended drive effect?)
- The guardian's feedback type (confirmation/correction/none)
- Observed drive effects

**Impact of not calling it:** No real reinforcement learning happens. Confidence never updates from actual feedback. Type 1 graduation never occurs from real experience. The predict-act-evaluate cycle is structurally complete but never closes the loop.

### 1.3 Person modeling (Other Evaluation)

**Where it breaks:** The architecture shows "Person Jim → Other Evaluation" in Communication. The `LlmContext` type has a `personModel: PersonModelSummary | null` field. Nothing populates it.

**What's needed:** A service that maintains a model of who Sylphie is talking to — what they've said, their preferences, how they typically interact. This feeds into the LLM system prompt so responses are calibrated to the person.

**Files involved:** The `PersonModelSummary` type exists in `packages/shared/src/types/llm.types.ts`. The Other KG (Grafeo) is the intended storage per CANON.

### 1.4 Theater Prohibition validation

**Where it breaks:** The LLM_GENERATE handler builds a system prompt with drive state, but there's no post-generation check that the output actually correlates with the drive state. CANON Standard 1 requires this.

**What's needed:** A theater validator that compares the generated response's sentiment/tone against the current drive state. If Sylphie's anxiety is high but the response is cheerful, that's a theater violation — the response should be flagged and the action gets zero reinforcement.

### 1.5 Conversation history

**Where it breaks:** The `LlmContext` type has `conversationHistory: readonly LlmMessage[]`. Nothing maintains this. Each LLM call only sees the current input, not the conversation so far.

**What's needed:** A conversation turn buffer that accumulates user/assistant exchanges within a session. The LLM_GENERATE handler should include recent turns in the messages array so Ollama has conversational context.

### 1.6 TTS_SPEAK action handler

**Where it breaks:** The `TTS_SPEAK` handler in `action-handler-registry.service.ts` is a stub that logs a warning.

**What's needed:** Wire it to `TtsService` in the app layer. The handler should take the text from a prior `LLM_GENERATE` step's output and synthesize audio.

---

## 2. Learning Subsystem (does not exist yet)

### 2.1 Consolidation → WKG writes

**Where it breaks:** `ConsolidationService` extracts entities and semantic relationships from mature episodes, but the extracted `SemanticConversion` objects are never written to Neo4j.

**What's needed:** The Learning subsystem should consume consolidation output and:
- Upsert entity nodes in the WKG
- Create relationship edges with confidence from the consolidation
- Respect provenance (guardian-derived content gets higher base confidence)
- Run contradiction detection against existing knowledge

**Files involved:**
- `packages/decision-making/src/episodic-memory/consolidation.service.ts` — produces SemanticConversion
- Neo4j WORLD instance — target for writes

### 2.2 Edge refinement (LLM-assisted)

**Where it breaks:** The architecture shows Learning using the LLM to refine edges. The `ILlmService` is available (OllamaLlmService registered under `LLM_SERVICE`), but no Learning service consumes it.

**What's needed:** A maintenance cycle that queries recent `hasLearnable` events from TimescaleDB (max 5 per cycle), uses the LLM to extract/refine semantic relationships, and writes them to the WKG.

### 2.3 CONTRADICTS edges

**Where it breaks:** `ContradictionScannerService` queries Neo4j for `CONTRADICTS` relationship edges before committing arbitration results. No such edges exist because nothing creates them.

**What's needed:** The Learning subsystem's contradiction detection should create `CONTRADICTS` edges when new knowledge conflicts with existing knowledge. These edges are then consumed by the contradiction scanner during arbitration.

---

## 3. Planning Subsystem (does not exist yet)

### 3.1 WKG procedure creation

**Where it breaks:** The action retriever queries the WKG for `ActionProcedure` nodes. Only 5 bootstrap seeds exist (greet, acknowledge, ask_clarification, express_curiosity, shrug). No new procedures are ever created.

**What's needed:** The Planning subsystem should:
- Receive opportunities from the Drive Engine (prediction failure patterns, behavioral narrowing, guardian teaching)
- Research the opportunity (query TimescaleDB for event frequency)
- Run simulations
- Propose plans → LLM constraint validation
- If validated, create new `ActionProcedure` nodes in the WKG

**Impact of not having it:** Sylphie can never learn new behaviors. She's limited to the 5 bootstrap seeds plus whatever Type 2 novel responses the LLM generates. There's no pathway from "LLM generated a good response" to "that response becomes a learned procedure."

### 3.2 Opportunity intake from Drive Engine

**Where it breaks:** The Drive Engine has `OPPORTUNITY_DETECTED` events and `OpportunityCreatedPayload` types. Nothing consumes them.

**What's needed:** A Planning intake service that subscribes to opportunity events and queues them for processing.

---

## 4. Drive Engine Connections

### 4.1 Outcome reporting payload shape

**Where it breaks:** `reportOutcome()` in `DecisionMakingService` calls `actionOutcomeReporter.reportOutcome()` with a manually constructed payload. The `IActionOutcomeReporter` interface expects an `ActionOutcomePayload` (defined in `ipc.types.ts`), but the shapes may not match exactly.

**What's needed:** Verify that the payload constructed in `reportOutcome()` matches `ActionOutcomePayload` field-for-field. Currently it passes `actionId`, `actionType`, `success`, `driveEffects`, `feedbackSource`, `theaterCheck` — all fields from the IPC type. Should be correct but hasn't been tested at runtime.

### 4.2 Software metrics reporting

**Where it breaks:** CANON requires LLM token usage and latency to be reported to the Drive Engine as `SoftwareMetricsPayload` for cognitive effort pressure computation. The `LLM_GENERATE` handler returns `tokensUsed` and `latencyMs` but nobody sends them to the Drive Engine.

**What's needed:** After an LLM call, construct a `SoftwareMetricsPayload` and send it via IPC. This feeds into the CognitiveAwareness drive pressure.

---

## 5. WKG_QUERY Action Handler

**Where it breaks:** The `WKG_QUERY` handler in `action-handler-registry.service.ts` is a stub.

**What's needed:** Wire it to Neo4jService to execute Cypher queries against the WORLD instance. Action procedures that include WKG_QUERY steps (e.g., "look up what I know about X before responding") need this to function.

---

## 6. Observation — Synthetic vs Real Outcomes

**Where it breaks:** In the OBSERVING state, `DecisionMakingService` creates a synthetic `ActionOutcome` with `predictionAccurate: false` and `predictionError: 1.0`. This means every prediction evaluates as a complete failure, which skews MAE and prevents Type 1 graduation.

**What's needed:** The OBSERVING state should construct the outcome from actual execution results:
- Did the LLM_GENERATE handler succeed? (execution success)
- What drive effects were observed between the pre-execution and post-execution snapshots? (actual drive delta)
- Was the prediction accurate? (compare predicted drive effects vs actual delta)

The real outcome is partially available from `executionResults` but the drive delta requires a second snapshot after execution, which isn't captured yet.

---

## Priority Order

Based on what unblocks the most functionality:

1. **Response delivery** (#1.1) — Without this, Sylphie processes input but never responds. Everything else is invisible.
2. **Conversation history** (#1.5) — Without this, LLM has no memory of the conversation.
3. **reportOutcome caller** (#1.2) — Without this, no reinforcement learning.
4. **Real observation outcomes** (#6) — Without this, all predictions fail and MAE is always 1.0.
5. **Software metrics to Drive Engine** (#4.2) — Without this, cognitive effort drive never builds.
6. **Procedure creation** (#3.1) — Without this, no learned behaviors.
7. **Consolidation writes** (#2.1) — Without this, episodic knowledge doesn't persist.
8. **Person modeling** (#1.3) — Enriches responses but not blocking.
9. **Theater validation** (#1.4) — Important for authenticity but not blocking.
10. **TTS_SPEAK handler** (#1.6) — Voice output, not blocking for text.
11. **WKG_QUERY handler** (#5) — Needed for knowledge-grounded responses.
12. **Edge refinement** (#2.2) — Needed for knowledge quality.
13. **CONTRADICTS edges** (#2.3) — Needed for coherence checking.
14. **Opportunity intake** (#3.2) — Needed for planned behavior.
15. **Outcome payload verification** (#4.1) — Verification, not implementation.
