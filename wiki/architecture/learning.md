# learning — Architecture Reference

> Living document. Last updated: 2026-06-13. Auto-generated from full-file reads (one agent per file); verify before trusting any single line.

**21 files** mapped.

## File-by-file

### `packages/learning/src/`

#### index.ts
*barrel* — Public API facade for Learning subsystem; exports only LearningModule, LEARNING_SERVICE token, and ILearningService interface type.

The Learning subsystem consolidates raw experience (TimescaleDB events) into durable knowledge (WKG nodes/edges). This barrel strictly encapsulates the subsystem: only three exports are public (module, injection token, and interface); all 11 internal pipeline step tokens (UPDATE_WKG_SERVICE, UPSERT_ENTITIES_SERVICE, EXTRACT_TYPED_EDGES_SERVICE, EXTRACT_EDGES_SERVICE, CONVERSATION_ENTRY_SERVICE, CAN_PRODUCE_EDGES_SERVICE, REFINE_EDGES_SERVICE, DETECT_CONTRADICTIONS_SERVICE, CONFIDENCE_DECAY_SERVICE, LEARNING_EVENT_LOGGER, CONVERSATION_REFLECTION_SERVICE, CROSS_SESSION_SYNTHESIS_SERVICE) are intentionally withheld. ILearningService defines five public methods: runMaintenanceCycle (processes up to 5 unlearned events), runReflectionCycle (holistic session analysis), runSynthesisCycle (cross-session pattern detection), forceCycle (drive-pressure driven), and runDecayCycle (confidence decay + pruning). Supporting result types include MaintenanceCycleResult, ReflectionResult, SynthesisCycleResult, DecayCycleResult with detail counters.

- **Exports:** `LearningModule`, `LEARNING_SERVICE`, `ILearningService`, `MaintenanceCycleResult`, `ReflectionResult`, `SynthesisCycleResult`, `DecayCycleResult`
- **Deps:** `./learning.module`, `./learning.tokens`, `./interfaces/learning.interfaces`
- **Gotchas:** Implementation details (all service classes, internal interfaces, pipeline tokens) deliberately NOT exported. This is strict architectural boundary enforcement per CANON — only the facade and result types are public.

#### learning.module.ts
*module* — NestJS module that wires Learning subsystem pipeline for consolidating raw experience into durable WKG knowledge

Implements CANON §Subsystem 3: converts TimescaleDB events (has_learned=false) into World Knowledge Graph (Neo4j WORLD) via 9-step pipeline. Exports sole public facade LEARNING_SERVICE (ILearningService). Internal providers: UpdateWkgService (schema+fetch), UpsertEntitiesService (Neo4j MERGE), ExtractTypedEdgesService (structured facts), ExtractEdgesService (co-occurrence RELATED_TO), ConversationEntryService (MENTIONS edges), CanProduceEdgesService (Word edges), RefineEdgesService (LLM refinement), DetectContradictionsService (post-refinement), ConfidenceDecayService (periodic decay+GC), ConversationReflectionService (session analysis), CrossSessionSynthesisService (multi-session synthesis), LearningEventLoggerService (audit trail). Imports DecisionMakingModule (exports LLM_SERVICE) and TimescaleModule (@Global). Respects CANON §No Circular Dependencies (no CommunicationModule or PlanningModule).

- **Exports:** `LEARNING_SERVICE`
- **Deps:** `@nestjs/common`, `@sylphie/decision-making`, `@sylphie/shared`, `./learning.tokens`, `./learning.service`, `./pipeline/*`, `./logging/learning-event-logger.service`
- **Gotchas:** All pipeline step tokens (UPDATE_WKG_SERVICE, UPSERT_ENTITIES_SERVICE, EXTRACT_TYPED_EDGES_SERVICE, EXTRACT_EDGES_SERVICE, CONVERSATION_ENTRY_SERVICE, CAN_PRODUCE_EDGES_SERVICE, REFINE_EDGES_SERVICE, DETECT_CONTRADICTIONS_SERVICE, CONFIDENCE_DECAY_SERVICE, CONVERSATION_REFLECTION_SERVICE, CROSS_SESSION_SYNTHESIS_SERVICE, LEARNING_EVENT_LOGGER) are intentionally NOT exported — internal implementation only. Circular dependency risk: module only imports DecisionMakingModule (safe) and TimescaleModule; explicitly guards against importing Communication or Planning.

#### learning.service.ts
*service* — Maintenance cycle orchestrator for the Learning subsystem — converts raw experience (TimescaleDB events) into durable knowledge (WKG entities and edges) through a 7-step pipeline executed in discrete, bounded cycles.

LearningService is a NestJS injectable service implementing ILearningService. It orchestrates four independent timer-driven maintenance cycles: runMaintenanceCycle (60s), runReflectionCycle (5m), runSynthesisCycle (30m), and runDecayCycle (10m). The core maintenance cycle processes up to 5 events per cycle (MAX_EVENTS_PER_CYCLE=5, a CANON cognitive constraint), executing a sequential 7-step pipeline per event: upsert entities, extract typed edges, extract co-occurrence edges, create conversation entry, create CAN_PRODUCE edges, refine edges via LLM, and mark as learned. Each cycle guards against overlap via boolean flags (cycleInFlight, reflectionInFlight, synthesisInFlight, decayInFlight). The service injects 11 specialized sub-services and an event logger, emitting CONSOLIDATION_CYCLE_STARTED/COMPLETED, ENTITY_EXTRACTED, and EDGE_REFINED events throughout. Error handling ensures broken events are marked learned anyway to prevent stalling.

- **Exports:** `LearningService`
- **Key constants:** `MAX_EVENTS_PER_CYCLE=5`, `CYCLE_INTERVAL_MS=60000`, `REFLECTION_INTERVAL_MS=300000`, `SYNTHESIS_INTERVAL_MS=1800000`, `DECAY_INTERVAL_MS=600000`
- **Deps:** `./interfaces/learning.interfaces`, `./learning.tokens`, `@sylphie/shared`
- **Gotchas:** Timer-based cycles are the fallback; future Cognitive Awareness drive should trigger maintenance cycles when pressure exceeds threshold (currently unimplemented). Overlap guards use simple boolean flags — no distributed locking for multi-instance scenarios. processEvent marks events as learned even on failure to prevent pipeline stalling, which could mask corrupted events.

#### learning.tokens.ts
*config* — NestJS injection token definitions for LearningModule

Defines 11 Symbol-based DI tokens: LEARNING_SERVICE (public, ILearningService facade), UPDATE_WKG_SERVICE (schema migration + TimescaleDB fetch), UPSERT_ENTITIES_SERVICE (entity extraction to Neo4j WORLD with provenance), EXTRACT_TYPED_EDGES_SERVICE (structured fact extraction via LLM; subject-predicate-object triples), EXTRACT_EDGES_SERVICE (co-occurrence RELATED_TO edges), CONVERSATION_ENTRY_SERVICE (Conversation nodes + MENTIONS edges), CAN_PRODUCE_EDGES_SERVICE (phrase extraction + Word nodes + CAN_PRODUCE edges), REFINE_EDGES_SERVICE (LLM edge classification with graceful degradation), DETECT_CONTRADICTIONS_SERVICE (post-refinement conflict detection), CONFIDENCE_DECAY_SERVICE (time-based decay + orphan pruning), LEARNING_EVENT_LOGGER (TimescaleDB audit trail), CONVERSATION_REFLECTION_SERVICE (holistic session analysis, LLM-assisted), CROSS_SESSION_SYNTHESIS_SERVICE (meta-insight synthesis across sessions). Only LEARNING_SERVICE is re-exported from index.ts; remainder are internal to LearningModule.

- **Exports:** `LEARNING_SERVICE`, `UPDATE_WKG_SERVICE`, `UPSERT_ENTITIES_SERVICE`, `EXTRACT_TYPED_EDGES_SERVICE`, `EXTRACT_EDGES_SERVICE`, `CONVERSATION_ENTRY_SERVICE`, `CAN_PRODUCE_EDGES_SERVICE`, `REFINE_EDGES_SERVICE`, `DETECT_CONTRADICTIONS_SERVICE`, `CONFIDENCE_DECAY_SERVICE`, `LEARNING_EVENT_LOGGER`, `CONVERSATION_REFLECTION_SERVICE`, `CROSS_SESSION_SYNTHESIS_SERVICE`
- **Gotchas:** All non-LEARNING_SERVICE tokens explicitly marked internal-only; multiple services gracefully skip when LLM unavailable (Lesion Test pattern); no error constants or thresholds defined here

### `packages/learning/src/interfaces/`

#### learning.interfaces.ts
*type* — Public and internal type contracts for the Learning subsystem consolidation pipeline

Defines the ILearningService public facade (runMaintenanceCycle, runReflectionCycle, runSynthesisCycle, forceCycle, runDecayCycle) and internal pipeline step interfaces (IUpdateWkgService, IUpsertEntitiesService, IExtractTypedEdgesService, IExtractEdgesService, IConversationEntryService, ICanProduceEdgesService, IRefineEdgesService, IDetectContradictionsService, IConfidenceDecayService). Includes result types (MaintenanceCycleResult, DecayCycleResult, ReflectionResult, SynthesisCycleResult), event data structures (UnlearnedEvent, ExtractedEntity, ExtractedEdge), reflection types (InsightType union of DELAYED_REALIZATION|MISSED_CONNECTION|IMPLICIT_INSTRUCTION|CONTRADICTION|THEMATIC_THREAD|TONAL_SHIFT, ReflectionInsight, SessionCandidate), and cross-session synthesis interfaces (InsightPair, SynthesisResult, ICrossSessionSynthesisService). Core thresholds: reflection confidence capped at INFERENCE base (0.30 for WKG writes), synthesis confidence cap 0.45 (1.5x base, below 0.60 ceiling). Maintenance cycle fetches up to 5 unlearned events, reflection finds sessions quiet ≥10 min with ≥4 events, synthesis examines pairs from different sessions sharing entity references. All LLM-assisted paths skip gracefully when unavailable.

- **Exports:** `ILearningService`, `MaintenanceCycleResult`, `UnlearnedEvent`, `ExtractedEntity`, `ExtractedEdge`, `IUpdateWkgService`, `IUpsertEntitiesService`, `IExtractTypedEdgesService`, `IExtractEdgesService`, `IConversationEntryService`, `ICanProduceEdgesService`, `IRefineEdgesService`, `IDetectContradictionsService`, `IConfidenceDecayService`, `DecayCycleResult`, `ILearningEventLogger`, `InsightType`, `ReflectionInsight`, `ReflectionResult`, `SessionCandidate`, `IConversationReflectionService`, `InsightPair`, `SynthesisResult`, `SynthesisCycleResult`, `ICrossSessionSynthesisService`
- **Key constants:** `INFERENCE base confidence=0.30`, `synthesis confidence cap=0.45`, `maintenance cycle limit=5 events`, `reflection quiet threshold=≥10 min`, `reflection min events=≥4`
- **Deps:** `@sylphie/shared (ProvenanceSource)`
- **Gotchas:** LLM-assisted reflection and synthesis paths skip gracefully when unavailable (Lesion Test support); reflection confidence capped at INFERENCE base (0.30), synthesis cap 0.45 (below 0.60 CANON ceiling); contradiction detection creates CONTRADICTS edges consumed by decision-making; typed edge extraction skips co-occurrence pairs already typed; no TODOs or dead code detected

### `packages/learning/src/logging/`

#### learning-event-logger.service.ts
*service* — Fire-and-forget event logger for Learning subsystem events to TimescaleDB

LearningEventLoggerService is an injectable NestJS service that implements ILearningEventLogger interface. It exposes a single log() method that accepts eventType (string), payload (Record<string, unknown>), and optional sessionId. The method generates a UUID, captures current timestamp, defaults sessionId to 'learning-internal' if not supplied, and issues an async INSERT to the 'events' table with columns: id, type, timestamp, subsystem, session_id, drive_snapshot, payload, schema_version. Error handling is fire-and-forget: errors are caught and emitted as warn-level logs rather than propagated, ensuring TimescaleDB failures do not abort maintenance cycles. Payload is stringified to JSON. drive_snapshot is hardcoded null (v1 limitation). schema_version is hardcoded 1. Verbose logging truncates string values in payload to 60 chars.

- **Exports:** `LearningEventLoggerService`
- **Key constants:** `resolvedSessionId default='learning-internal'`, `subsystem='LEARNING'`, `schema_version=1`, `drive_snapshot=null`, `payload truncation=60 chars`
- **Deps:** `@nestjs/common`, `crypto`, `@sylphie/shared (TimescaleService, verboseFor)`, `../interfaces/learning.interfaces (ILearningEventLogger)`
- **Gotchas:** drive_snapshot hardcoded null is acknowledged v1 limitation; fire-and-forget error handling silently suppresses DB failures; no validation of eventType or payload shape

### `packages/learning/src/pipeline/`

#### can-produce-edges.service.ts
*service* — Step 6 of Learning maintenance cycle: extract multi-word phrases from events, merge Word nodes in Neo4j, create CAN_PRODUCE edges from Conversation to Word nodes.

CanProduceEdgesService is a NestJS injectable service implementing ICanProduceEdgesService. Primary method createEdges(conversationNodeId, event) extracts significant phrases from event content, merges Word nodes via mergeWordNode(), then creates CAN_PRODUCE edges via mergeCanProduceEdge(). Significant phrase definition: two or more consecutive words each >= 3 chars (MIN_TOKEN_LENGTH=3, MIN_PHRASE_TOKENS=2). Phrase extraction uses sliding window to generate bigrams and trigrams, capped at 15 phrases per event (MAX_PHRASES_PER_EVENT=15). Word nodes are created with LLM_GENERATED provenance and 0.35 confidence; CAN_PRODUCE edges use INFERENCE provenance and 0.30 confidence. Both Node and edge writes use Neo4j WORLD instance with MERGE+ON CREATE/ON MATCH patterns to handle idempotency. extractContent() helper pulls from event.payload.content or .text; extractSignificantPhrases() tokenizes on whitespace/punctuation, filters by MIN_TOKEN_LENGTH, then generates bigram+trigram phrases using deduplication Set.

- **Exports:** `CanProduceEdgesService`
- **Key constants:** `MIN_TOKEN_LENGTH=3`, `MIN_PHRASE_TOKENS=2`, `MAX_PHRASES_PER_EVENT=15`, `WORD_PROVENANCE='LLM_GENERATED'`, `WORD_CONFIDENCE=0.35`, `CAN_PRODUCE_PROVENANCE='INFERENCE'`, `CAN_PRODUCE_CONFIDENCE=0.30`
- **Deps:** `@nestjs/common`, `crypto.randomUUID`, `@sylphie/shared (Neo4jService, verboseFor)`, `../interfaces/learning.interfaces (ICanProduceEdgesService, UnlearnedEvent)`
- **Gotchas:** mergeCanProduceEdge receives unused _wordNodeId parameter (likely refactoring artifact); phrase extraction ignores single-word tokens entirely and caps output at 15 phrases, so long event content will truncate; Neo4j session errors logged as warn but silently return 0/false to caller; no validation that conversationNodeId actually exists before MATCH attempt

#### confidence-decay.service.spec.ts
*test* — Unit tests for retrieval-aware confidence decay in WS3 T3, verifying coalesce-based decay keying and compounding loop closure.

Test suite for ConfidenceDecayService covering four behavioral contracts: (1) node-decay Cypher uses coalesce(last_retrieval_at, updated_at, created_at) as the load-bearing fallback to close T2→T3 compounding loop; (2) edge-decay intentionally omits last_retrieval_at (T2 only reinforces nodes); (3) decay runs only against WORLD instance, never OTHER/OKG (deferred to T4 stub §2.11); (4) coalesce backward-compatibility and reinforced-durability proofs via decay formula mirror. Includes CapturingNeo4j fake to capture Cypher and verify query shape, coalesceLastActivity and decay formula mirrors in JS (hoursSince = (now - lastActivityMs) / 3600000, newConf = max(0, conf - decayRate * ln(hoursSince + 1)) if hoursSince > MIN_HOURS_BEFORE_DECAY). Four test cases verify: query shape (coalesce present, old CASE WHEN gone), edge-decay omits retrieval field, WORLD-only scope, never-reinforced fallback, reinforced node divergence upward from control, and fresh-use shield (unchanged within 1h).

- **Key constants:** `MIN_HOURS_BEFORE_DECAY=1.0`
- **Deps:** `@sylphie/shared (Neo4jInstanceName)`, `./confidence-decay.service (ConfidenceDecayService)`
- **Gotchas:** Decay formula constant (decayRate=0.06) inferred from test setup rather than imported; coalesce behavior and live DB divergence proven via formula mirror but actual Cypher execution mocked (CapturingNeo4j returns empty records); T4 stub for OTHER instance decay is deferred; no integration test against live Neo4j

#### confidence-decay.service.ts
*service* — Periodic decay and garbage collection of knowledge confidence in the World Knowledge Graph (WORLD instance) using ACT-R base-level activation principles.

ConfidenceDecayService is an injectable NestJS service that implements IConfidenceDecayService, running a periodic decay cycle. The cycle has three stages: (1) decayNodes() applies time-based confidence reduction to all non-schema nodes using per-provenance decay rates (SENSOR=0.05, GUARDIAN=0.03, LLM_GENERATED=0.08, INFERENCE=0.06) with formula new_conf = max(0.0, old_conf - decayRate * ln(hoursSince+1)), reading from last_retrieval_at (set by reinforce edge), falling back to updated_at then created_at via coalesce(); (2) decayEdges() applies the same decay formula to edges (no last_retrieval_at support for edges yet); (3) pruneOrphanedNodes() deletes :Entity nodes with confidence <= PRUNE_THRESHOLD (0.10) that have no relationships, preserving structural nodes (Drive, CoBeing, ActionProcedure, Conversation, Insight, Word). The MIN_HOURS_BEFORE_DECAY threshold (1.0 hour) prevents freshly-touched nodes from decaying on the same cycle. Decay operates only on WORLD instance (WKG); OTHER instance (OKG) decay is deferred per stub §2.11. runDecayCycle() returns DecayCycleResult with counts and wasNoop flag.

- **Exports:** `ConfidenceDecayService`
- **Key constants:** `PRUNE_THRESHOLD=0.10`, `MIN_HOURS_BEFORE_DECAY=1.0`, `SENSOR_DECAY=0.05`, `GUARDIAN_DECAY=0.03`, `LLM_GENERATED_DECAY=0.08`, `INFERENCE_DECAY=0.06`
- **Deps:** `@nestjs/common`, `@sylphie/shared (Neo4jService, Neo4jInstanceName, verboseFor)`, `../interfaces/learning.interfaces`
- **Gotchas:** Edge decay does NOT yet read last_retrieval_at (noted WS3 T3: only nodes are reinforced by use→reinforce edge); OKG decay deferred to future gate-design (stub 2.11); toNumber() helper handles Neo4j Integer conversion; all queries guard against schema_level='schema' and structural labels; decay only applies where hoursSince > MIN_HOURS_BEFORE_DECAY; errors in any step log warning and return 0 but do not fail the cycle.

#### conversation-entry.service.ts
*service* — Step 5 of Learning maintenance cycle: creates Conversation nodes in Neo4j WORLD and links to extracted entities via MENTIONS edges.

ConversationEntryService is a NestJS injectable that processes UnlearnedEvents and ExtractedEntities to create temporal anchors in the WKG. Main method createEntry() generates a Conversation node with a truncated content field (max 500 chars), records event_id and timestamp, sets provenance to SENSOR with confidence 0.4 (representing sensor observations), and wires MENTIONS edges from the Conversation node to each valid entity. Private createConversationNode() writes the node to WORLD instance with properties: node_id (UUID-derived), label, content, event_id, timestamp, event_type, session_id, provenance_type, confidence, schema_level, created_at. writeMentionsEdges() creates MERGE edges for each entity; handles missing entities gracefully with per-edge error logging. Pure helper extractContent() extracts text from event.payload with fallback.

- **Exports:** `ConversationEntryService`
- **Key constants:** `MAX_CONTENT_CHARS=500`, `CONV_PROVENANCE="SENSOR"`, `CONV_CONFIDENCE=0.4`
- **Deps:** `@nestjs/common`, `@sylphie/shared (Neo4jService, Neo4jInstanceName, verboseFor)`, `../interfaces/learning.interfaces (IConversationEntryService, UnlearnedEvent, ExtractedEntity)`
- **Gotchas:** createEntry returns empty string on node creation failure (line 75) but still returns convNodeId on success; MENTIONS edges are created with MERGE so duplicate edges collapse silently; no transaction wrapping across node creation and edge writes, so partial failures possible if edge writes fail after node creation succeeds; extractContent uses duck-typed payload access (payload['content'] or payload['text']).

#### conversation-reflection.service.spec.ts
*test* — Unit tests for computeGroundedConfidence pure function — verifies grounding-based confidence scaling across five scenarios.

Tests the computeGroundedConfidence(attemptedReveals, succeededReveals) function, which computes adjusted confidence and grounding status for conversation insights. Five test suites: (A) No entity references (0 attempted) → base confidence 0.30, grounded=true, ratio=1; (B) Partial grounding (some matched) → confidence scaled by ratio, grounded=true, returns correct ratio; (C) Zero grounding (0 matched) → floor 0.05, grounded=false, ratio=0; (D) Full grounding (all matched) → full base 0.30, grounded=true, ratio=1; (E) Floor enforcement at 0.05 — prevents sub-floor values but doesn't apply when ratio produces ≥0.05. The function is pure (no I/O, no DI), so no mocks needed. BASE constant is 0.30 (REFLECTION_CONFIDENCE module-level value). Key algorithm: adjustedConfidence = max(BASE * (succeededReveals / attemptedReveals), 0.05); grounded = (succeededReveals > 0 OR attemptedReveals === 0); groundingRatio = attemptedReveals === 0 ? 1 : succeededReveals / attemptedReveals.

- **Key constants:** `BASE=0.30`
- **Deps:** `./conversation-reflection.service`
- **Gotchas:** No stubs or TODOs. Function is pure, tests are isolated and independent. Tests verify symbolic reference to base constant for clarity but no literal constant exported from service.

#### conversation-reflection.service.ts
*service* — Holistic conversation analysis for the Learning subsystem, triggered every 5 minutes to extract multi-event insights from quiet sessions.

ConversationReflectionService analyzes completed conversations (narrative units) to discover insights invisible to single-event processing. Finds sessions quiet for 10+ minutes (SESSION_QUIET_THRESHOLD_MS=600000ms) with 4+ events (MIN_EVENTS_FOR_REFLECTION), calls LLM with full conversation history (max 8000 chars), parses 6 insight types (DELAYED_REALIZATION, MISSED_CONNECTION, IMPLICIT_INSTRUCTION, CONTRADICTION, THEMATIC_THREAD, TONAL_SHIFT) with LLM-suggested confidence 0.0-1.0. Each insight creates an Insight node in Neo4j WKG, DERIVED_FROM edges linking to session Conversation nodes, and REVEALS edges to referenced Entity nodes. Confidence is grounded (scaled by entity-match ratio; floor 0.05) and tracked via reflected_sessions TimescaleDB table. Exports computeGroundedConfidence() for testing. If LLM unavailable, reflection skips (no marking as reflected, enables retry). Provenance=INFERENCE, base confidence=0.30, temperature=0.3, max_tokens=1536, tier=medium.

- **Exports:** `ConversationReflectionService`, `computeGroundedConfidence`
- **Key constants:** `SESSION_QUIET_THRESHOLD_MS=600000`, `MIN_EVENTS_FOR_REFLECTION=4`, `MAX_CONVERSATION_CHARS=8000`, `MAX_INSIGHTS_PER_SESSION=10`, `REFLECTION_PROVENANCE='INFERENCE'`, `REFLECTION_CONFIDENCE=0.30`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `../interfaces/learning.interfaces`, `../learning.tokens`
- **Gotchas:** LLM unavailability is detected via llm.isAvailable() and reflection skips without marking session reflected (enables automatic retry when LLM returns); parseReflectionResponse() stops at MAX_INSIGHTS_PER_SESSION to guard against runaway LLM output; REVEALS edge grounding ratio can be 0 (no entities matched in WKG), which sets grounded=false and floors confidence at 0.05 rather than 0.0 for potential later confirmation; discovered entity edges (writeDiscoveredEdge) are created via MERGE+ON_CREATE_SET but failures are caught and logged non-fatally; insight.suggestedEdge relies on EDGE_LINE_RE parsing which validates relType against VALID_EDGE_TYPES (14 hardcoded values); Insight node labels truncate description to 60 chars; case-insensitive entity matching used throughout (toLower).

#### cross-session-synthesis.service.spec.ts
*test* — Unit tests for pure helper functions of CrossSessionSynthesisService

Tests two exported pure functions: computeSynthesisConfidence(c1, c2, sharedEntityCount) and parseSynthesisResponse(content, sourceId1, sourceId2). computeSynthesisConfidence uses arithmetic mean of two confidence values with floor at BASE=0.30, cap at CAP=0.45, and overlap bonus of +0.02 per entity beyond the first (capped at +0.10). parseSynthesisResponse parses LLM-formatted text with PATTERN_FOUND, PATTERN_TYPE, DESCRIPTION, and CITES fields; validates both source IDs appear in CITES (confabulation guard); handles invalid types, whitespace, malformed input, and case-insensitive boolean parsing.

- **Key constants:** `BASE=0.30`, `CAP=0.45`, `ID1=insight-aaa11111`, `ID2=insight-bbb22222`
- **Deps:** `./cross-session-synthesis.service`
- **Gotchas:** Tests only pure helpers; service class wiring and Neo4j/TimescaleDB integration are NOT tested here. Valid InsightType values are: DELAYED_REALIZATION, MISSED_CONNECTION, IMPLICIT_INSTRUCTION, CONTRADICTION, THEMATIC_THREAD, TONAL_SHIFT.

#### cross-session-synthesis.service.ts
*service* — Second-order reflection: detects meta-patterns across multiple sessions by comparing Insight node pairs that share entity references via LLM synthesis.

CrossSessionSynthesisService (NestJS @Injectable) is the core export. It finds pairs of Insight nodes from different sessions that share entities via REVEALS edges (findSynthesizablePairs), sends them to an LLM with structured prompts for pattern detection (synthesizePair), and persists synthesis Insight nodes with SYNTHESIZES edges back to the sources (persistSynthesisNode). Schema ensureSchema creates synthesized_insight_pairs TimescaleDB table for deduplication. Key constants: MAX_PAIRS_PER_CYCLE=3 (token budget), SYNTHESIS_BASE_CONFIDENCE=0.30, SYNTHESIS_CONFIDENCE_CAP=0.45 (CANON §ceiling 0.60 unpassed), SYNTHESIS_PROVENANCE='INFERENCE', MIN_OVERLAP_RATIO=0.0. LLM call temperature=0.2 (conservative). Confabulation guards: strict line-by-line parsing of LLM response (PATTERN_FOUND/PATTERN_TYPE/DESCRIPTION/CITES fields), citesVerified checks both source IDs are cited, failed parse discards result. computeSynthesisConfidence applies mean of source confidences + 0.02 per shared entity (capped +0.10), floored at 0.30, capped at 0.45. parseSynthesisResponse uses four regex patterns to extract fields; any missing field or citation failure → patternFound=false. Writes: Neo4j Insight nodes (synthesis label, is_synthesis=true, grounded=true), SYNTHESIZES edges, REVEALS edges to shared entities. Reads: Neo4j (Insight pairs via REVEALS overlap), TimescaleDB (already-synthesized pairs). Lesion: if LLM unavailable, synthesis skipped (per-session learning continues).

- **Exports:** `CrossSessionSynthesisService`, `computeSynthesisConfidence`, `parseSynthesisResponse`, `ParsedSynthesisResponse`
- **Key constants:** `MAX_PAIRS_PER_CYCLE=3`, `SYNTHESIS_PROVENANCE='INFERENCE'`, `SYNTHESIS_BASE_CONFIDENCE=0.30`, `SYNTHESIS_CONFIDENCE_CAP=0.45`, `MIN_OVERLAP_RATIO=0.0`, `PATTERN_FOUND_RE=/^PATTERN_FOUND:\s*(true\|false)\s*$/i`, `PATTERN_TYPE_RE=/^PATTERN_TYPE:\s*([A-Z_]+)\s*$/`, `DESCRIPTION_RE=/^DESCRIPTION:\s*(.+)$/`, `CITES_RE=/^CITES:\s*(.+)$/`, `temperature=0.2`, `maxTokens=512`, `SYNTHESIS_SYSTEM_PROMPT=[multi-line]`
- **Deps:** `@nestjs/common`, `@sylphie/shared (LLM_SERVICE, TimescaleService, Neo4jService, verboseFor)`, `../interfaces/learning.interfaces`, `../learning.tokens`
- **Gotchas:** filterAlreadySynthesized silently returns all candidates if synthesized_insight_pairs table doesn't exist (graceful degrade). persistSynthesisNode catches and logs entity REVEALS failures non-critically (entity may have been removed). Neo4j Integer type requires .toNumber() conversion (toNumber helper). LLM.isAvailable() check is optional (llm injected as @Optional). Response parsing requires exact field format; any deviation → confabulation guard rejects. All synthesis nodes marked session_id='synthesis' (not tied to a real session). Lesion test note: synthesis completely skipped if LLM unavailable.

#### detect-contradictions.service.ts
*service* — Post-refinement contradiction detection between semantically opposing relationship types.

DetectContradictionsService (injectable) detects contradictions after edge refinement classifies RELATED_TO edges into typed relationships (LIKES, DISLIKES, WORKS_AT, etc.). It checks whether a newly typed edge contradicts an existing edge between the same entity pair using ANTONYM_PAIRS (currently LIKES↔DISLIKES). When a contradiction is found, a CONTRADICTS edge is created with conflict metadata (claim, existingFact, claimConfidence=0.35, existingConfidence=0.60, detected_at timestamp, event_id, session_id, fixed confidence=0.50). This edge is consumed by ContradictionScannerService for decision-making pre-action coherence checks. Only typed edges (not RELATED_TO) are checked. The service is pure graph logic with no LLM calls, supporting Lesion Tests when LLM is unavailable. All graph operations use Neo4j (WORLD instance, WRITE mode).

- **Exports:** `DetectContradictionsService`
- **Key constants:** `ANTONYM_MAP={LIKES↔DISLIKES}`, `CONTRADICTS_confidence=0.50`
- **Deps:** `@nestjs/common`, `@sylphie/shared`
- **Gotchas:** ANTONYM_MAP only contains LIKES/DISLIKES pair; other typed edges in pipeline go unchecked for contradictions. Sanitize() function replaces non-alphanumeric with underscore for Cypher injection safety. No bidirectional checks explicitly handled — query uses undirected match (-[]-) to catch both directions. Exception handling returns false on query failure without retrying.

#### extract-edges.service.ts
*service* — Step 4 of Learning cycle: creates RELATED_TO edges between co-occurring entities in Neo4j WORLD

ExtractEdgesService implements IExtractEdgesService. Main method extractEdges() takes entities and an event, builds entity pairs (using sentence-level co-occurrence when content available, fallback to all-pairs), then batches a single UNWIND+MERGE Cypher statement to create RELATED_TO edges in Neo4j. Provenance is LLM_GENERATED with confidence 0.35; ON MATCH only increases confidence, never decreases. Helper functions buildPairs() and buildSentencePairs() generate pair candidates, filtering out already-typed pairs and capping at MAX_PAIRS. extractContent() extracts text from event payload. All pairs are processed in one Neo4j session with atomic failure tolerance.

- **Exports:** `ExtractEdgesService`
- **Key constants:** `MAX_PAIRS=10`, `EDGE_PROVENANCE='LLM_GENERATED'`
- **Deps:** `@nestjs/common`, `@sylphie/shared (Neo4jService, Neo4jInstanceName, resolveBaseConfidence, verboseFor)`, `../interfaces/learning.interfaces (IExtractEdgesService, ExtractedEntity, ExtractedEdge, UnlearnedEvent)`
- **Gotchas:** Sentence splitting uses regex /(?<=[.!?])\s+/ which may fail on edge cases (abbreviations, ellipsis); entity label matching is case-insensitive substring search that could collide with partial matches; if batch merge fails all pairs lost but will be rederived on next cycle; missing Entity nodes result in dropped results with warn log but query continues

#### extract-typed-edges.service.ts
*service* — Parse structured (subject, predicate, object) facts from event text and create typed WKG edges immediately, bypassing blind co-occurrence refinement.

ExtractTypedEdgesService is a NestJS injectable that extracts typed edges by parsing event content text for patterns like "I like X" → (Speaker)-[LIKES]->(X), "X works at Y" → (X)-[WORKS_AT]->(Y). The core logic parseTriples() matches regex patterns for speaker-centric facts (I like/work/live/am-from) and third-person observations (X likes Y, knows Z). Each matched triple is resolved to entity nodes (upserting value entities if needed) and written to the WORLD Neo4j graph via writeTypedEdge(). Edges marked with provenance (GUARDIAN=0.60, SENSOR=0.40) and refined_from="STRUCTURED". Returns both edges array and typedPairs Set to signal downstream co-occurrence pipeline which pairs already have typed relations.

- **Exports:** `ExtractTypedEdgesService`
- **Key constants:** `FACT_KEY_TO_EDGE_TYPE={likes:LIKES,dislikes:DISLIKES,occupation:WORKS_AS,works_at:WORKS_AT,location:LIVES_IN,origin:FROM,name:NAMED,identity:IS_A,age:HAS_AGE}`, `FAVORITE_PREFIX="favorite_"`, `confidence_GUARDIAN=0.60`, `confidence_SENSOR=0.40`, `confidence_valueEntity=0.50`, `objectLabel_maxLength=50`
- **Deps:** `@nestjs/common`, `@sylphie/shared:Neo4jService,verboseFor`, `../interfaces/learning.interfaces:IExtractTypedEdgesService,ExtractedEntity,ExtractedEdge,UnlearnedEvent`
- **Gotchas:** parseTriples() uses mutable `as any` casts to attach _subjectLabel to triples for third-person patterns (lines 234,246,258,270)—nonstandard tuple extension; findSpeakerEntity() returns GUARDIAN-provenance entity or SENSOR fallback, which may be inaccurate if multiple sources exist; upsertValueEntity() generates random nodeId on CREATE but accepts returned value on MATCH, potential race condition; writeTypedEdge() dynamically constructs Neo4j relationship label via sanitize(factKey)—if factKey contains invalid chars, edge label gets mangled; no validation that subject/object actually resolve, loop just continues silently

#### refine-edges.service.spec.ts
*test* — Unit tests for classifyByHeuristic pure function — deterministic edge-type refinement with heuristic verb-phrase matching.

Tests the pure, side-effect-free classifyByHeuristic() function exported from refine-edges.service. Covers all 7 supported edge types (LIKES, DISLIKES, KNOWS, WORKS_AT, LIVES_AT, CREATED, OWNS) with positive cases matching canonical verb phrases (e.g., 'likes', 'dislikes', 'hates', 'knows', 'met', 'works at', 'works for', 'lives in', 'resides in', 'created', 'built', 'wrote', 'authored', 'owns', 'belongs to'), negative cases ensuring patterns don't fire when labels are absent or incomplete, empty/whitespace context handling, rule ordering (DISLIKES takes priority over LIKES via substring containment), intentional exclusion of USES type, proximity window fallback (120 char radius when no shared sentence), and case-insensitive label matching. Helper ctx() builds context sentences by formatting 'source verb target.' Pattern. Returns object with confident (boolean) and newType (edge type string).

- **Exports:** `(imports classifyByHeuristic)`
- **Key constants:** `WINDOW_RADIUS=120`
- **Deps:** `./refine-edges.service`
- **Gotchas:** Proximity window uses 120 chars but exact constant not visible in test file (inferred from test case). USES deliberately excluded and tested that it returns confident=false. Substring containment with 'dislikes' containing 'likes' requires rule ordering to prevent false match. Case handling is stated but implementation in imported function not visible here.

#### refine-edges.service.ts
*service* — LLM-assisted edge refinement in the learning maintenance cycle (Step 7) using heuristics and LLM classification.

RefineEdgesService refines generic RELATED_TO edges in the knowledge graph into specific types. Two-phase approach: Phase 1 applies verb-derived heuristic rules (DISLIKES, LIKES, KNOWS, WORKS_AT, LIVES_AT, CREATED, OWNS) using a context window strategy. Phase 2 submits remaining ambiguous edges to the LLM (temperature 0.3) with optional person-context enrichment from recent interactions. Supports Lesion Test by gracefully skipping Phase 2 when LLM unavailable. Uses Neo4j MERGE pattern to create refined relationships and deletes original RELATED_TO edges. Provenance is preserved from extraction stage (LLM_GENERATED, SENSOR, or GUARDIAN); refinement source tracked separately in refined_from property.

- **Exports:** `RefineEdgesService`, `HeuristicClassification`, `classifyByHeuristic`
- **Key constants:** `VALID_TYPE_RE=/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/`, `PERSON_CONTEXT_LIMIT=5`, `WINDOW_RADIUS=120`, `REFINEMENT_LINE_RE=/^EDGE:\s*(.+?)\s*->\s*(.+?)\s*\\|\s*([A-Z_]+)\s*$/`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `learning.interfaces`
- **Gotchas:** No entity-label-only rules yet (deferred until semantic typing available). USES pattern intentionally omitted as too noisy. Heuristic edges carry existing confidence (no boost). LLM response parsing is lenient (ignores malformed lines). Person-context fallback silently returns empty string on DB error. Neo4j session management uses try/finally correctly.

#### update-wkg.service.ts
*service* — Step 2 of Learning maintenance cycle: schema migration, fetching unlearned events, and marking events as learned.

UpdateWkgService is a NestJS Injectable service (implements IUpdateWkgService and OnModuleInit). OnModuleInit calls ensureSchema() which adds a has_learned BOOLEAN column to the events table (idempotent via IF NOT EXISTS) and creates a partial index on timestamp WHERE has_learned=false for query performance. fetchUnlearnedEvents(limit) queries TimescaleDB for unlearned events where type IN ('INPUT_RECEIVED', 'INPUT_PARSED'), ordered by timestamp ASC (oldest first per CANON), returning up to limit rows; on error returns empty array. markAsLearned(eventId) sets has_learned=true for a single event by id. All DB operations wrapped in try-catch with logging; errors are logged but not rethrown to prevent app startup failure. Uses TimescaleService injected dependency and verboseFor('Learning') for debug logging.

- **Exports:** `UpdateWkgService`
- **Key constants:** `vlog verboseFor('Learning')`, `EVENT_TYPES: INPUT_RECEIVED, INPUT_PARSED`, `COLUMN DEFAULT: false`, `INDEX_NAME: idx_events_unlearned`
- **Deps:** `@nestjs/common`, `@sylphie/shared`, `../interfaces/learning.interfaces`
- **Gotchas:** Migration failure is silently caught (not rethrown) — app starts but WKG queries may fail later. fetchUnlearnedEvents returns empty array on DB error rather than throwing. No enforcement of CANON max 5 events per cycle limit — caller (LearningService) passes limit but no validation here.

#### upsert-entities.service.ts
*service* — Extract entity names from unlearned events and merge them into Neo4j WORLD knowledge graph (Step 3 of Learning maintenance cycle).

UpsertEntitiesService implements IUpsertEntitiesService with upsertEntities() that extracts entity labels from UnlearnedEvent payloads, resolves provenance (SENSOR for INPUT_*/derived, GUARDIAN for GUARDIAN_* events), and merges nodes into Neo4j. MERGE logic: ON CREATE sets full properties (node_id, node_type, provenance_type, confidence, created_at); ON MATCH only increases confidence if higher and refreshes updated_at. Entity extraction uses title-cased token heuristic with compound entity merging ("New York City" as one entity, not three). Stopwords and temporal words (day/month names) filtered via STOPWORDS and TEMPORAL_WORDS Sets. Sentence-initial words only kept if they also appear mid-sentence elsewhere (confirming proper noun, not just capitalization). MAX_ENTITIES_PER_EVENT=20 enforced. Returns ExtractedEntity[] with nodeId, label, provenance, confidence. Tracks created vs updated counts.

- **Exports:** `UpsertEntitiesService`
- **Key constants:** `MAX_ENTITIES_PER_EVENT=20`, `STOPWORDS=["the","this","that",...59 words]`, `TEMPORAL_WORDS=["monday",...27 words]`
- **Deps:** `@nestjs/common`, `crypto.randomUUID`, `@sylphie/shared (Neo4jService, Neo4jInstanceName, resolveBaseConfidence, verboseFor, ProvenanceSource)`, `../interfaces/learning.interfaces (IUpsertEntitiesService, UnlearnedEvent, ExtractedEntity)`
- **Gotchas:** Node ID generation uses entity-${UUID.substring(0,8)} prefix for created nodes, but MERGE returns matched node's existing ID; code checks nodeId.startsWith("entity-") to distinguish created vs updated. SESSION handle for Neo4j obtained but error returns empty string silently (not throwing). extractTitleCasedTokens() first pass over mid-sentence capitals requires full text scan before filtering sentence-initial words; no persistent memoization across calls. No TODO/stub comments but compound entity merging is complex heuristic that may miss edge cases (e.g., "Dr. John Smith" hyphenated mid-word).

## Risks / stubs / TODOs

- `packages/learning/src/index.ts` — Implementation details (all service classes, internal interfaces, pipeline tokens) deliberately NOT exported. This is strict architectural boundary enforcement per CANON — only the facade and result types are public.
- `packages/learning/src/interfaces/learning.interfaces.ts` — LLM-assisted reflection and synthesis paths skip gracefully when unavailable (Lesion Test support); reflection confidence capped at INFERENCE base (0.30), synthesis cap 0.45 (below 0.60 CANON ceiling); contradiction detection creates CONTRADICTS edges consumed by decision-making; typed edge extraction skips co-occurrence pairs already typed; no TODOs or dead code detected
- `packages/learning/src/learning.module.ts` — All pipeline step tokens (UPDATE_WKG_SERVICE, UPSERT_ENTITIES_SERVICE, EXTRACT_TYPED_EDGES_SERVICE, EXTRACT_EDGES_SERVICE, CONVERSATION_ENTRY_SERVICE, CAN_PRODUCE_EDGES_SERVICE, REFINE_EDGES_SERVICE, DETECT_CONTRADICTIONS_SERVICE, CONFIDENCE_DECAY_SERVICE, CONVERSATION_REFLECTION_SERVICE, CROSS_SESSION_SYNTHESIS_SERVICE, LEARNING_EVENT_LOGGER) are intentionally NOT exported — internal implementation only. Circular dependency risk: module only imports DecisionMakingModule (safe) and TimescaleModule; explicitly guards against importing Communication or Planning.
- `packages/learning/src/learning.service.ts` — Timer-based cycles are the fallback; future Cognitive Awareness drive should trigger maintenance cycles when pressure exceeds threshold (currently unimplemented). Overlap guards use simple boolean flags — no distributed locking for multi-instance scenarios. processEvent marks events as learned even on failure to prevent pipeline stalling, which could mask corrupted events.
- `packages/learning/src/learning.tokens.ts` — All non-LEARNING_SERVICE tokens explicitly marked internal-only; multiple services gracefully skip when LLM unavailable (Lesion Test pattern); no error constants or thresholds defined here
- `packages/learning/src/logging/learning-event-logger.service.ts` — drive_snapshot hardcoded null is acknowledged v1 limitation; fire-and-forget error handling silently suppresses DB failures; no validation of eventType or payload shape
- `packages/learning/src/pipeline/can-produce-edges.service.ts` — mergeCanProduceEdge receives unused _wordNodeId parameter (likely refactoring artifact); phrase extraction ignores single-word tokens entirely and caps output at 15 phrases, so long event content will truncate; Neo4j session errors logged as warn but silently return 0/false to caller; no validation that conversationNodeId actually exists before MATCH attempt
- `packages/learning/src/pipeline/confidence-decay.service.spec.ts` — Decay formula constant (decayRate=0.06) inferred from test setup rather than imported; coalesce behavior and live DB divergence proven via formula mirror but actual Cypher execution mocked (CapturingNeo4j returns empty records); T4 stub for OTHER instance decay is deferred; no integration test against live Neo4j
- `packages/learning/src/pipeline/confidence-decay.service.ts` — Edge decay does NOT yet read last_retrieval_at (noted WS3 T3: only nodes are reinforced by use→reinforce edge); OKG decay deferred to future gate-design (stub 2.11); toNumber() helper handles Neo4j Integer conversion; all queries guard against schema_level='schema' and structural labels; decay only applies where hoursSince > MIN_HOURS_BEFORE_DECAY; errors in any step log warning and return 0 but do not fail the cycle.
- `packages/learning/src/pipeline/conversation-entry.service.ts` — createEntry returns empty string on node creation failure (line 75) but still returns convNodeId on success; MENTIONS edges are created with MERGE so duplicate edges collapse silently; no transaction wrapping across node creation and edge writes, so partial failures possible if edge writes fail after node creation succeeds; extractContent uses duck-typed payload access (payload['content'] or payload['text']).
- `packages/learning/src/pipeline/conversation-reflection.service.spec.ts` — No stubs or TODOs. Function is pure, tests are isolated and independent. Tests verify symbolic reference to base constant for clarity but no literal constant exported from service.
- `packages/learning/src/pipeline/conversation-reflection.service.ts` — LLM unavailability is detected via llm.isAvailable() and reflection skips without marking session reflected (enables automatic retry when LLM returns); parseReflectionResponse() stops at MAX_INSIGHTS_PER_SESSION to guard against runaway LLM output; REVEALS edge grounding ratio can be 0 (no entities matched in WKG), which sets grounded=false and floors confidence at 0.05 rather than 0.0 for potential later confirmation; discovered entity edges (writeDiscoveredEdge) are created via MERGE+ON_CREATE_SET but failures are caught and logged non-fatally; insight.suggestedEdge relies on EDGE_LINE_RE parsing which validates relType against VALID_EDGE_TYPES (14 hardcoded values); Insight node labels truncate description to 60 chars; case-insensitive entity matching used throughout (toLower).
- `packages/learning/src/pipeline/cross-session-synthesis.service.spec.ts` — Tests only pure helpers; service class wiring and Neo4j/TimescaleDB integration are NOT tested here. Valid InsightType values are: DELAYED_REALIZATION, MISSED_CONNECTION, IMPLICIT_INSTRUCTION, CONTRADICTION, THEMATIC_THREAD, TONAL_SHIFT.
- `packages/learning/src/pipeline/cross-session-synthesis.service.ts` — filterAlreadySynthesized silently returns all candidates if synthesized_insight_pairs table doesn't exist (graceful degrade). persistSynthesisNode catches and logs entity REVEALS failures non-critically (entity may have been removed). Neo4j Integer type requires .toNumber() conversion (toNumber helper). LLM.isAvailable() check is optional (llm injected as @Optional). Response parsing requires exact field format; any deviation → confabulation guard rejects. All synthesis nodes marked session_id='synthesis' (not tied to a real session). Lesion test note: synthesis completely skipped if LLM unavailable.
- `packages/learning/src/pipeline/detect-contradictions.service.ts` — ANTONYM_MAP only contains LIKES/DISLIKES pair; other typed edges in pipeline go unchecked for contradictions. Sanitize() function replaces non-alphanumeric with underscore for Cypher injection safety. No bidirectional checks explicitly handled — query uses undirected match (-[]-) to catch both directions. Exception handling returns false on query failure without retrying.
- `packages/learning/src/pipeline/extract-edges.service.ts` — Sentence splitting uses regex /(?<=[.!?])\s+/ which may fail on edge cases (abbreviations, ellipsis); entity label matching is case-insensitive substring search that could collide with partial matches; if batch merge fails all pairs lost but will be rederived on next cycle; missing Entity nodes result in dropped results with warn log but query continues
- `packages/learning/src/pipeline/extract-typed-edges.service.ts` — parseTriples() uses mutable `as any` casts to attach _subjectLabel to triples for third-person patterns (lines 234,246,258,270)—nonstandard tuple extension; findSpeakerEntity() returns GUARDIAN-provenance entity or SENSOR fallback, which may be inaccurate if multiple sources exist; upsertValueEntity() generates random nodeId on CREATE but accepts returned value on MATCH, potential race condition; writeTypedEdge() dynamically constructs Neo4j relationship label via sanitize(factKey)—if factKey contains invalid chars, edge label gets mangled; no validation that subject/object actually resolve, loop just continues silently
- `packages/learning/src/pipeline/refine-edges.service.spec.ts` — Proximity window uses 120 chars but exact constant not visible in test file (inferred from test case). USES deliberately excluded and tested that it returns confident=false. Substring containment with 'dislikes' containing 'likes' requires rule ordering to prevent false match. Case handling is stated but implementation in imported function not visible here.
- `packages/learning/src/pipeline/refine-edges.service.ts` — No entity-label-only rules yet (deferred until semantic typing available). USES pattern intentionally omitted as too noisy. Heuristic edges carry existing confidence (no boost). LLM response parsing is lenient (ignores malformed lines). Person-context fallback silently returns empty string on DB error. Neo4j session management uses try/finally correctly.
- `packages/learning/src/pipeline/update-wkg.service.ts` — Migration failure is silently caught (not rethrown) — app starts but WKG queries may fail later. fetchUnlearnedEvents returns empty array on DB error rather than throwing. No enforcement of CANON max 5 events per cycle limit — caller (LearningService) passes limit but no validation here.
- `packages/learning/src/pipeline/upsert-entities.service.ts` — Node ID generation uses entity-${UUID.substring(0,8)} prefix for created nodes, but MERGE returns matched node's existing ID; code checks nodeId.startsWith("entity-") to distinguish created vs updated. SESSION handle for Neo4j obtained but error returns empty string silently (not throwing). extractTitleCasedTokens() first pass over mid-sentence capitals requires full text scan before filtering sentence-initial words; no persistent memoization across calls. No TODO/stub comments but compound entity merging is complex heuristic that may miss edge cases (e.g., "Dr. John Smith" hyphenated mid-word).

## Change log
- 2026-06-13 — Initial auto-generated map (21 files read in full).
