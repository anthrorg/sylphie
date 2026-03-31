# Epic 6: Communication Subsystem -- Ticket Templates

Use these templates to create detailed Jira/GitHub issues for E6-T001 through E6-T012.

---

## E6-T001: Type System & Interfaces

**Title:** Define type system and DI interfaces for Communication subsystem

**Size:** Medium (2 days)

**Description:**
Define all TypeScript interfaces, types, and DI tokens for the Communication subsystem. This ticket establishes the boundary contracts that all other tickets implement against.

**Deliverables:**
- `src/communication/types.ts` — all interface definitions
- `src/communication/exceptions/` — all custom exception classes
- `src/shared/tokens.ts` — DI injection tokens (INPUT_PARSER_SERVICE, PERSON_MODELING_SERVICE, etc.)
- Documentation in each file

**Type Definitions Needed:**
- `ParsedInput` — output of input parsing
- `ResponseGenerationContext` — LLM context assembly
- `ResponseGenerationResult` — output of response generation
- `PersonModel` — sanitized person model interface
- `TheaterValidationResult` — output of Theater validator
- `TranscriptionResult` — output of STT
- `DriveSnapshot` — read-only drive state

**Exceptions Needed:**
- `STTDegradationError` — thrown when STT fails, triggers text fallback
- `TTSDegradationError` — thrown when TTS fails, triggers text-only output
- `TheaterDetectedException` — for debugging (not thrown, just logged)

**Acceptance Criteria:**
- [ ] No `any` types except where explicitly necessary
- [ ] All interfaces exported and documented with JSDoc
- [ ] DI tokens registered correctly (const symbol with descriptive name)
- [ ] Type safety: TypeScript strict mode passes
- [ ] Cross-references with CANON vocabulary (ActionIntent, DriveSnapshot, etc.)

**Notes:**
- Start with interfaces from vox.md agent profile
- Reference E2 (Events) and E3 (Knowledge) type definitions for consistency
- Ensure PersonModel interface has NO graph properties (_grafeoGraph must be private)

---

## E6-T002: Communication Module Skeleton & DI Wiring

**Title:** Create CommunicationModule with DI configuration and initialization

**Size:** Medium (2 days)

**Description:**
Set up the NestJS CommunicationModule as the root container for all communication services. Wire all dependencies, implement OnModuleInit/OnModuleDestroy lifecycle hooks, and ensure proper initialization order.

**Deliverables:**
- `src/communication/communication.module.ts` — main module
- `src/communication/communication.providers.ts` — factory providers for complex services
- OpenAI client configuration and connection pool setup

**Key Responsibilities:**
1. Import required modules (ConfigModule, KnowledgeModule, EventsModule, DriveEngineModule)
2. Declare all service providers (DeterministicClassifierService, PersonModelingService, etc.)
3. Export public services (INPUT_PARSER_SERVICE, PERSON_MODELING_SERVICE, etc.)
4. Implement OnModuleInit to:
   - Initialize OpenAI client (Whisper, TTS)
   - Prepare audio hardware if available
   - Load pre-computed acknowledgments cache
   - Verify all Grafeo instances are sealed
5. Implement OnModuleDestroy to:
   - Close OpenAI connections gracefully
   - Flush pending events to TimescaleDB
   - Cleanup audio resources

**Acceptance Criteria:**
- [ ] CommunicationModule loads without errors during app bootstrap
- [ ] All services are injectable with full dependency graph resolved
- [ ] OnModuleInit executes and completes successfully
- [ ] OnModuleDestroy executes and closes all resources cleanly
- [ ] Unit tests verify dependency resolution (4+ test cases)
- [ ] No circular dependencies detected by NestJS linter

**Notes:**
- Ensure OpenAI client is configured with API key from ConfigService
- Audio hardware initialization should be optional (degrade gracefully if unavailable)
- Pre-computed acknowledgments cache: ["I see", "Hmm", "Okay", "Got it"] with TTS audio

---

## E6-T003: Input Parser Service Implementation

**Title:** Implement InputParserService with LLM-assisted parsing and Type 1/Type 2 arbitration

**Size:** Large (5 days)

**Description:**
Build the complete input parsing pipeline: text/voice → structured intent + entities + context. Include Type 1 pattern matching with fallback to LLM-assisted Type 2, entity resolution against WKG, guardian feedback detection, and learnable event tagging.

**Deliverables:**
- `src/communication/input-parsing/input-parser.service.ts` — main service (IInputParserService)
- `src/communication/input-parsing/deterministic-classifier.service.ts` — Type 1 pattern matcher
- `src/communication/input-parsing/parsing-prompt.ts` — LLM prompt templates
- Tests: `src/communication/__tests__/input-parser.integration.spec.ts`

**Key Methods:**
```typescript
parse(input: string, source: 'TEXT' | 'VOICE'): Promise<ParsedInput>
buildParsedInput(...): Promise<ParsedInput>
resolveEntityWithWKG(entity: ExtractedEntity): Promise<ResolvedEntity>
computeLearnableAspects(...): string[]
recordParsingEvent(...): Promise<void>
```

**Type 1 Classifier (DeterministicClassifierService):**
- Pattern-match on common intents (question markers, correction phrases, etc.)
- Train patterns from v1 co-being repo if available
- Return confidence score
- Fallback to LLM if confidence < 0.75

**Guardian Feedback Detection:**
- CORRECTION: detect "No, that's...", "Actually...", "You were wrong..."
- TEACHING: detect "Did you know...", "The thing is...", "I should explain..."
- CONFIRMATION: detect "Right", "Exactly", "Yes"
- NONE: neutral input

**Entity Resolution:**
- Query WKG for each extracted entity
- Return matched nodes and unresolved references
- Tag unresolved as learnable

**Acceptance Criteria:**
- [ ] Parser correctly identifies 6+ intent types
- [ ] Guardian feedback detection works for 20+ test cases
- [ ] Entity resolution matches 80%+ of known entities
- [ ] Type 1 (pattern matching) succeeds for common inputs with >75% confidence
- [ ] Type 2 (LLM) fallback works smoothly
- [ ] Latency: Type 1 < 50ms, Type 2 < 200ms
- [ ] Cost tracked per parse with context='input_parsing'
- [ ] Learnable aspects computed correctly (new_entity, correction, teaching, etc.)
- [ ] 15+ unit tests covering intents, feedback types, entities, edge cases
- [ ] Integration test with mock WKG

**Notes:**
- Use v1 conversation-engine parser structure as reference
- Fine-tune LLM prompt to be very precise (temperature=0)
- Learnable aspects: ['new_entity'] if unresolvedReferences.length > 0, ['correction'] if CORRECTION, etc.

---

## E6-T004: Person Modeling Service (Grafeo Isolation)

**Title:** Implement PersonModelingService with strict Grafeo isolation and per-person KG instances

**Size:** Large (5 days)

**Description:**
Build person modeling system with one isolated Grafeo instance per person. Enforce strict architectural isolation: no cross-contamination with WKG or Self KG, no graph references in public interface, and type-level enforcement of isolation boundaries.

**Deliverables:**
- `src/communication/person-modeling/person-modeling.service.ts` — main service (IPersonModelingService)
- `src/communication/person-modeling/person-model.builder.ts` — PersonModel construction
- `src/communication/person-modeling/grafeo-isolation.enforcer.ts` — isolation verification
- Tests: `src/communication/__tests__/person-modeling.isolation.spec.ts`

**Key Methods:**
```typescript
getPersonModel(personId: string): Promise<PersonModel>
updateFromConversation(personId: string, conversation: Message): Promise<void>
upsertToPersonGraph(graph: GrafeoGraph, update: PersonUpdate): Promise<void> [private]
recomputePersonModel(model: PersonModel, graph: GrafeoGraph): Promise<void> [private]
sanitizePersonModel(model: PersonModel): PersonModel [private]
```

**Isolation Enforcement:**
- Grafeo instances stored in private Map<string, GrafeoGraph>
- Public interface (getPersonModel) returns sanitized PersonModel with NO graph properties
- Private _grafeoGraph property NEVER exposed
- Type system ensures no accidental graph access

**Person Model Schema (in Grafeo):**
- Person node: id, name, role (GUARDIAN|PEER|STRANGER)
- Communication edges: PREFERS_TOPIC, COMMUNICATES_ABOUT
- Feedback edges: CORRECTS_ABOUT, TEACHES_ABOUT
- Properties computed from interaction history

**Computed Views:**
- communicationStyle: { averageResponseTime, preferredTopics, correctionFrequency, engagementLevel, responseLatency }
- observedStates: { currentMood, topicSensitivities, positiveReinforcers }

**Acceptance Criteria:**
- [ ] Each person gets isolated Grafeo instance
- [ ] getPersonModel() returns sanitized PersonModel (no graph access)
- [ ] Isolation test: modifying Person_Jim does not affect WKG
- [ ] Isolation test: modifying Person_Jim does not affect Self KG
- [ ] Isolation test: modifying WKG does not affect any Person KG
- [ ] PersonModel interface has no _grafeoGraph property accessible
- [ ] Type system prevents direct graph access (TS strict mode)
- [ ] updateFromConversation writes ONLY to person's isolated graph
- [ ] Communication style computed correctly (response time, topic preferences, correction frequency)
- [ ] Engagement level (0-1) computed from response patterns
- [ ] Response latency p95 calculated correctly
- [ ] 12+ isolation and functionality tests
- [ ] Integration test with concurrent persons

**Notes:**
- Use v1 PersonModelService as reference, but rewrite for Grafeo API
- Seal Grafeo instances: no new nodes, only property updates
- Person models persist across sessions (check CANON for persistence requirements)

---

## E6-T005: LLM Service & Cost Tracking

**Title:** Implement LLMService with Anthropic API integration, token accounting, and cost tracking

**Size:** Medium (3 days)

**Description:**
Create complete LLM integration layer for Claude API. Handle token counting, cost calculation (2026-03-29 pricing), retry logic with exponential backoff, and per-subsystem cost attribution.

**Deliverables:**
- `src/communication/llm/llm.service.ts` — main service (ILlmService)
- `src/communication/llm/cost-tracker.service.ts` — billing system
- `src/communication/llm/llm.config.ts` — pricing tables and configuration
- Tests: `src/communication/__tests__/llm.service.spec.ts`

**Key Methods:**
```typescript
complete(request: LLMRequest): Promise<LLMResponse>
estimateCost(inputTokens, outputTokens, model): number
retryWithBackoff(request, attempts): Promise<LLMResponse> [private]
```

**LLMRequest Interface:**
- systemPrompt: string
- userPrompt: string
- maxTokens?: number
- temperature?: number
- model?: 'claude-3-5-sonnet-20241022' | 'claude-3-opus-20250219'

**LLMResponse Interface:**
- text: string
- estimatedInputTokens: number
- estimatedOutputTokens: number
- estimatedCost: number (USD)
- latency: number (ms)
- model: string
- stopReason: 'end_turn' | 'max_tokens'

**Pricing (as of 2026-03-29):**
- Sonnet input: $3/MTok ($0.003/1000 tokens)
- Sonnet output: $15/MTok ($0.015/1000 tokens)
- Opus input: $15/MTok
- Opus output: $75/MTok

**Retry Logic:**
- Retry on 429 (rate limit), 503 (service unavailable), ETIMEDOUT
- Exponential backoff: 1s, 2s, 4s delays
- Max 3 attempts

**Cost Attribution:**
- Every LLM call tagged with context (input_parsing, response_generation, planning_simulation, learning_refinement)
- Cost tracked per context type for budget monitoring

**Acceptance Criteria:**
- [ ] Successfully calls Claude API
- [ ] Token counts match Anthropic's token counter
- [ ] Cost calculation matches published pricing (within 0.1%)
- [ ] Retry logic handles rate limits and transient errors
- [ ] Exponential backoff delays correct (1s, 2s, 4s)
- [ ] Cost tagged with context for attribution
- [ ] Latency measured (LLM inference only, not network)
- [ ] Non-retriable errors (auth, bad request) fail immediately
- [ ] Unit tests: cost calculation, retry logic, error handling (8+ tests)
- [ ] Integration test with live Anthropic API (test account)

**Notes:**
- Use Anthropic SDK for token counting if available
- Store pricing in configuration (allow tuning without redeployment)
- Track usage per subsystem for budget alerts

---

## E6-T006: Response Generator Service

**Title:** Implement ResponseGeneratorService with context assembly, drive injection, and Theater validation

**Size:** Large (6 days)

**Description:**
Build the core response generation pipeline: assemble LLM context from drive state, WKG, episodic memory, and person model; inject drive state into system prompt; call LLM; validate against Theater Prohibition; regenerate on Theater detection.

**Deliverables:**
- `src/communication/response-generation/response-generator.service.ts` — main service
- `src/communication/response-generation/context-assembler.service.ts` — context building
- `src/communication/response-generation/drive-narrative.builder.ts` — drive→text conversion
- `src/communication/response-generation/person-narrative.builder.ts` — person→context conversion
- Tests: `src/communication/__tests__/response-generator.integration.spec.ts`

**Key Methods:**
```typescript
generateResponse(request: ResponseGenerationRequest): Promise<ResponseGenerationResult>
assembleContext(request): Promise<ResponseGenerationContext>
constructPrompts(request, context): { systemPrompt, userPrompt }
constructDriveNarrative(driveState): string
constructPersonNarrative(personModel): string
regenerateWithConstraint(...): Promise<ResponseGenerationResult>
```

**Context Assembly:**
1. Read drive state (read-only from Drive Engine)
2. Query person model (sanitized from PersonModelingService)
3. Fetch recent conversation history (last 10 messages)
4. Query WKG for relevant knowledge (top 5 related nodes)
5. Compute topic confidence from knowledge

**Drive Narrative Example:**
```
You feel quite curious (0.75). You feel some anxiety (0.55).
You feel satisfied (0.72). You are getting bored (0.65).
```

**System Prompt Structure:**
- Identity: "You are Sylphie, an AI companion..."
- Theater Prohibition: "Speak authentically to your current drive state..."
- Drive state: constructed narrative
- Person context: "About the person you're talking to..."
- Knowledge: relevant WKG nodes
- Constraints: "Keep response to X words", "Don't hallucinate"

**Post-Generation Theater Validation:**
- Call TheaterValidator
- If isTheater=true: regenerate with explicit constraint + lower temperature
- Don't re-regenerate infinitely (max 1 retry)

**Acceptance Criteria:**
- [ ] Context assembly complete and correct
- [ ] Drive state injected into system prompt (no exceptions)
- [ ] Person model integrated with communication style details
- [ ] WKG knowledge context retrieved and formatted
- [ ] Theater Prohibition validation called on all responses
- [ ] Re-generation on Theater detection with constraint
- [ ] All responses tagged has_learnable=true
- [ ] Latency tracking per component (context, LLM, validation)
- [ ] Cost attribution: response_generation subsystem tag
- [ ] Max response length appropriate (150-256 tokens)
- [ ] 12+ unit tests covering context, prompts, drive narrative
- [ ] Integration test: full flow with mock LLM

**Notes:**
- Drive narrative: only describe drives > 0.5 (avoid noise)
- Person narrative: include communication style, preferences, correction frequency
- WKG knowledge: prioritize recent/high-confidence nodes
- Temperature tuning: 0.7 for balance, lower (0.5) for regeneration

---

## E6-T007: Theater Validator

**Title:** Implement TheaterValidator with emotional valence extraction and drive correlation checking

**Size:** Medium (3 days)

**Description:**
Build Theater Prohibition validator: extract emotional valence from LLM-generated responses using LLM, compute drive valence from drive state, compare for correlation, flag if > 0.4 deviation.

**Deliverables:**
- `src/communication/theater/theater-validator.ts` — main validator
- `src/communication/theater/emotional-valence.analyzer.ts` — valence extraction
- Tests: `src/communication/__tests__/theater-validator.spec.ts`

**Key Methods:**
```typescript
validate(response: string, driveState: DriveSnapshot): Promise<TheaterValidationResult>
analyzeEmotionalValence(response): Promise<{ valence, emotions }>
computeDriveValence(driveState): number
computeCorrelation(emotionalValence, driveValence): number
```

**Emotional Valence Extraction:**
- Use LLM to analyze response text
- Extract: valence (-1.0 to 1.0), detected emotions (list)
- LLM prompt: ask for JSON response with valence and emotion tags

**Drive Valence Computation:**
- Positive drives: satisfaction (1.0 weight), curiosity (0.8), social (0.6)
- Negative drives: anxiety (1.0), guilt (0.8), sadness (1.0), boredom (0.7)
- Formula: (positive - negative) / 2, clamped to [-1, 1]

**Correlation Calculation:**
- correlation = 1.0 - |emotionalValence - driveValence| / 2.0
- Range: [0, 1]
- 1.0 = perfect alignment
- 0.0 = complete opposite
- Threshold for theater: correlation < 0.4 (more than 0.4 points off)

**TheaterValidationResult:**
- response, driveState, emotionalValence, driveValence
- driveCorrelation, detectedEmotions, isTheater
- reinforcementMultiplier (0.0 if theater, 1.0 otherwise)

**Acceptance Criteria:**
- [ ] LLM-assisted valence extraction works
- [ ] Emotional detection (excitement, sadness, etc.) accurate
- [ ] Drive valence computed from all 12 drives
- [ ] Correlation formula correct (1 - |diff| / 2)
- [ ] Theater threshold at 0.4 correctly flags theatrical responses
- [ ] Edge case: low drive + neutral response = authentic (not theater)
- [ ] Edge case: high drive + strong emotion = not theater
- [ ] Reinforcement multiplier set correctly (0.0 for theater, 1.0 for authentic)
- [ ] Unit tests: valence extraction, correlation computation, threshold (10+ tests)
- [ ] Integration test: full response → validation → reinforcement

**Notes:**
- Valence extraction LLM prompt should be precise (temperature=0)
- Allow for tolerance: maybe "somewhat excited" with moderate curiosity is ok
- Consider tuning threshold in future (empirical observation after deployment)

---

## E6-T008: STT Pipeline (Whisper)

**Title:** Implement STTService with OpenAI Whisper integration and graceful text fallback

**Size:** Medium (2 days)

**Description:**
Build speech-to-text pipeline using OpenAI Whisper API. Transcribe audio with confidence scoring, handle failures gracefully by prompting for text input, track latency and confidence.

**Deliverables:**
- `src/communication/voice/stt.service.ts` — main service (ISTTService)
- Tests: `src/communication/__tests__/stt.service.spec.ts`

**Key Methods:**
```typescript
transcribe(audioBuffer: Buffer): Promise<TranscriptionResult>
logprobToConfidence(segments): number [private]
```

**TranscriptionResult:**
- text: string (transcribed text)
- confidence: number (0-1, from logprobs)
- latency: number (ms)
- wordTimestamps: { word, start, end }[] (for sentence-level TTS)
- source: 'WHISPER'

**Whisper API Call:**
- model: 'whisper-1'
- language: 'en'
- response_format: 'verbose_json' (includes segments with logprobs)
- timestamp_granularities: ['word']

**Confidence Mapping:**
- Whisper logprobs range: -inf to 0
- Convention: -0.1 = very confident, -2.0 = not confident
- Map [-2.0, 0] to [0, 1]: confidence = max(0, min(1, (avgLogprob + 2.0) / 2.0))

**Error Handling:**
- STT failure: throw STTDegradationError (not fatal exception)
- Voice controller catches STTDegradationError and prompts for text
- Record failure event to TimescaleDB

**Acceptance Criteria:**
- [ ] Whisper API called successfully
- [ ] Verbose JSON response with word-level timestamps
- [ ] Confidence computed correctly from logprobs
- [ ] Success event recorded (text, confidence, latency)
- [ ] STT failure throws STTDegradationError (graceful degradation)
- [ ] Failure event recorded (error message, error code)
- [ ] Latency measured and tracked
- [ ] Handles empty/silent audio gracefully
- [ ] Unit tests: success case, failure case, confidence mapping (6+ tests)
- [ ] Integration test with recorded audio sample

**Notes:**
- Whisper API is stable and well-documented
- Word-level timestamps enable sentence-level TTS streaming
- Confidence scoring helps prioritize re-asking for clarification if too low

---

## E6-T009: TTS Pipeline (OpenAI TTS with Streaming)

**Title:** Implement TTSService with sentence-level streaming and latency optimization

**Size:** Large (4 days)

**Description:**
Build text-to-speech pipeline with latency optimization through sentence-level streaming. While LLM generates, start TTS on first sentence. Play first sentence while synthesizing second, etc. This masks synthesis latency and keeps response time under 2 seconds.

**Deliverables:**
- `src/communication/voice/tts.service.ts` — main service (ITTSService)
- `src/communication/voice/audio-controller.ts` — audio playback queue
- Tests: `src/communication/__tests__/tts.service.spec.ts`

**Key Methods:**
```typescript
synthesizeAndPlay(text: string): Promise<void>
splitIntoSentences(text): string[] [private]
synthesizeSentence(sentence, index): Promise<Buffer> [private]
```

**AudioController:**
```typescript
enqueue(buffer: Buffer): void
playNext(): Promise<void> [private]
```

**Pipeline Architecture:**
1. Split response into sentences
2. Begin synthesis of sentence 1 (non-blocking)
3. As soon as sentence 1 is ready, start playback
4. In parallel, synthesize sentence 2
5. When sentence 1 finishes playing, sentence 2 is ready → play it

**Sentence Splitting:**
- Split on `.`, `!`, `?` followed by space or end-of-string
- Regex: `/(?<=[.!?])\s+/`
- Filter empty sentences

**TTS Synthesis:**
- Model: 'tts-1'
- Voice: 'nova' (configurable per user preference)
- Speed: 1.0

**Latency Tracking:**
- Time to first byte (first sentence ready)
- Time per sentence synthesis
- Total synthesis time

**Acceptance Criteria:**
- [ ] Sentence-level splitting works correctly
- [ ] Parallel synthesis of multiple sentences
- [ ] Streaming playback: play while synthesizing
- [ ] Latency to first byte < 500ms (ideally < 300ms)
- [ ] Audio controller maintains queue and plays in order
- [ ] Graceful fallback: TTSDegradationError on TTS failure
- [ ] Error recovery: skip failed sentence, continue with next
- [ ] Latency per component tracked and logged
- [ ] 8+ unit tests covering splitting, synthesis, playback queue
- [ ] Integration test: latency measurement on real audio hardware

**Notes:**
- Pre-synthesize acknowledgments: cache audio for "I see", "Hmm", "Okay"
- Temperature parameter not available for TTS (use tts-1 model, not tts-1-hd, for speed)
- Voice selection: allow per-user configuration in PersonModel

---

## E6-T010: Chatbox Interface (WebSocket)

**Title:** Implement ChatboxGateway with WebSocket support for text conversation

**Size:** Medium (3 days)

**Description:**
Build WebSocket gateway for text-based conversation when voice is unavailable or for explicit text input. Handle connections, message routing, and event recording.

**Deliverables:**
- `src/communication/chatbox/chatbox.gateway.ts` — WebSocket gateway
- `src/communication/chatbox/conversation.service.ts` — conversation tracking
- Tests: `src/communication/__tests__/chatbox.gateway.spec.ts`

**Key Methods:**
```typescript
afterInit(server: Server): void
handleConnection(client: Socket): Promise<void>
handleDisconnect(client: Socket): Promise<void>
@SubscribeMessage('chat_message')
handleChatMessage(client: Socket, payload: ChatMessagePayload): Promise<void>
```

**WebSocket Events:**
- **emit 'chat_response'**: server → client, response text with metadata
- **emit 'error'**: server → client, error message
- **on 'chat_message'**: client → server, user input

**ChatMessagePayload:**
```typescript
{
  text: string;
  timestamp?: Date;
}
```

**ChatResponsePayload:**
```typescript
{
  text: string;
  driveCorrelation: number;
  isTheater: boolean;
  timestamp: Date;
}
```

**Connection Tracking:**
- Map<clientId, WebSocketConnection> with personId, connectedAt
- Extract personId from handshake query or header
- Clean up on disconnect

**Message Flow:**
1. Client sends chat_message
2. InputParserService parses input
3. Record input event to TimescaleDB
4. ResponseGeneratorService generates response
5. Server emits chat_response to client
6. Record output event to TimescaleDB

**Acceptance Criteria:**
- [ ] WebSocket gateway initializes on /communication namespace
- [ ] Client connections tracked with person ID
- [ ] Connection event recorded (personId, clientId)
- [ ] Chat messages parsed and routed to response generator
- [ ] Responses sent back with full metadata (driveCorrelation, isTheater)
- [ ] Disconnect event recorded with session duration
- [ ] Error handling: errors returned as events, not connection termination
- [ ] Multiple concurrent clients supported (1-way isolation per connection)
- [ ] Graceful degradation if response generator fails
- [ ] Unit tests: connection, message handling, disconnect (8+ tests)
- [ ] Integration test: full flow from client message to response

**Notes:**
- Extract personId from `client.handshake.query.personId` or header
- Graceful error responses: don't close connection on one bad message
- Support multi-user: each connection isolated by person ID

---

## E6-T011: Social Drive Contingency Tracker

**Title:** Implement Social Drive Contingency tracking for 30-second response window reward

**Size:** Medium (2 days)

**Description:**
Track Sylphie-initiated comments and detect when guardian responds within 30 seconds. Emit contingency event for Drive Engine to apply extra reward (Social -0.15 + Satisfaction +0.10).

**Deliverables:**
- `src/communication/social-drive/social-comment-quality-tracker.ts` — tracker service
- Tests: `src/communication/__tests__/social-contingency.spec.ts`

**Key Methods:**
```typescript
recordInitiatedComment(id, conversationId, personId, text): Promise<void>
recordGuardianResponse(conversationId, personId, responseText): Promise<void>
findTargetUtterance(conversationId, explicit?): TrackedUtterance | null [private]
```

**TrackedUtterance:**
```typescript
{
  id: string;
  conversationId: string;
  personId: string;
  text: string;
  initiatedAt: Date;
  respondedAt?: Date;
  respondedWithinWindow: boolean;
}
```

**Timing Logic:**
- Record Sylphie comment with timestamp
- When guardian responds, check response time
- If response < 35 seconds: emit SOCIAL_COMMENT_QUALITY_HIT event
- Drive Engine reads event and applies 2x Guardian weight (from CANON)

**Causal Linking:**
- Explicit linking: response includes reference to specific utterance ID
- Implicit inference: most recent unreplied comment in conversation
- Each comment can earn its own contingency (multiple comments in same conversation)

**Event Emission:**
```typescript
{
  type: 'SOCIAL_COMMENT_QUALITY_HIT',
  commentId: string,
  conversationId: string,
  personId: string,
  responseTimeMs: number,
  commentText: string,
  responseText: string,
  driveReward: { social: -0.15, satisfaction: 0.10 },
}
```

**Acceptance Criteria:**
- [ ] Utterances tracked with unique IDs and timestamps
- [ ] 35-second window (30s + tolerance) correctly identifies contingency
- [ ] Contingency event emitted to TimescaleDB with correct structure
- [ ] Multiple utterances can each earn their own contingency
- [ ] Causal linking: response linked to correct utterance (explicit or inferred)
- [ ] Old comments cleaned up after 5 minutes
- [ ] Unit tests: window boundary (34.9s pass, 35.1s fail), multiple utterances (6+ tests)
- [ ] Integration test: full flow from Sylphie-initiated comment to Drive Engine reward

**Notes:**
- Window: 35 seconds (30s requirement + 5s tolerance for network jitter)
- Multiple comments in same conversation each tracked separately
- Implies Sylphie should initiate comments frequently (Social drive incentive)

---

## E6-T012: Integration Test Suite & Performance Benchmarks

**Title:** Comprehensive integration tests covering full Communication pipeline and latency benchmarks

**Size:** Large (5 days)

**Description:**
Build comprehensive integration test suite covering the full Communication subsystem: input parsing, response generation, validation, person modeling isolation, social drive contingency, and latency profiles. Run performance benchmarks against targets.

**Deliverables:**
- `src/communication/__tests__/communication.integration.spec.ts` — main test suite
- `src/communication/__tests__/isolation.integration.spec.ts` — person KG isolation tests
- `src/communication/__tests__/latency.benchmark.spec.ts` — latency profiling
- `src/communication/__tests__/cost.tracking.spec.ts` — cost accuracy
- Test fixtures and mock services

**Test Scenarios:**

### 1. End-to-End Pipeline
```typescript
test('full pipeline: text input → parse → response → output', async () => {
  // 1. Guardian sends: "What is a mug?"
  // 2. InputParser identifies QUESTION, extracts entity 'mug'
  // 3. WKG resolves 'mug' to existing node
  // 4. ResponseGenerator assembles context, calls LLM
  // 5. TheaterValidator confirms response matches drive state
  // 6. Response: "A mug is a drinking container"
  // 7. Event recorded with has_learnable=true
})
```

### 2. Theater Detection
```typescript
test('theater detection: high emotion, low drive → regenerate', async () => {
  // Drive state: Satisfaction 0.1, Curiosity 0.15 (both low)
  // LLM generates: "I'm so excited about this!"
  // Theater validator flags: emotional valence 0.9, drive valence -0.2
  // Correlation = 0.35 < 0.4 → isTheater=true
  // LLM asked to regenerate with constraint
  // Second response: neutral tone matching drive state
})
```

### 3. Person KG Isolation
```typescript
test('person isolation: Person_Jim updates ≠ WKG updates', async () => {
  const initialWKGCount = await wkg.countAllNodes();

  // Update Person_Jim model
  await personModelService.updateFromConversation('Person_Jim', message);

  const finalWKGCount = await wkg.countAllNodes();
  expect(finalWKGCount).toBe(initialWKGCount); // unchanged
})

test('person isolation: no shared edges between Person KG and WKG', async () => {
  const personModel = await personModelService.getPersonModel('Person_Jim');
  // PersonModel is sanitized, no graph reference
  expect((personModel as any)._grafeoGraph).toBeUndefined();
})
```

### 4. Social Drive Contingency
```typescript
test('30-second window: guardian response within 35s → contingency event', async () => {
  // Sylphie initiates: "I'm curious about your day"
  // Record in SocialCommentQualityTracker at T+0
  // Guardian responds at T+10s
  // Tracker detects response within 35s window
  // Emit SOCIAL_COMMENT_QUALITY_HIT event
  // Drive Engine applies Social -0.15 + Satisfaction 0.10 (2x weight)
})
```

### 5. Cost Tracking
```typescript
test('cost attribution: input_parsing, response_generation, etc.', async () => {
  // Parse input (0.5 LLM call)
  // Generate response (1.5 LLM call)
  // Verify cost recorded per context type
  // Verify total cost < $0.05 per interaction
})
```

### 6. Fallback Pathways
```typescript
test('STT failure → text prompt', async () => {
  // STT throws STTDegradationError
  // Voice controller catches and prompts: "I couldn't hear. Type instead?"
  // User types response
  // Conversation continues
})

test('TTS failure → text-only output', async () => {
  // TTS throws TTSDegradationError
  // Response sent via chatbox instead of voice
  // No exception, graceful degradation
})
```

### 7. Concurrent Users
```typescript
test('multiple persons in simultaneous conversations', async () => {
  // Clients for Person_Jim, Person_Guardian2, Person_Stranger
  // Each sends messages concurrently
  // Person models isolated per person
  // Responses generated in parallel
  // All complete within SLA
})
```

**Performance Benchmarks:**

| Component | Target | Acceptance Criteria |
|-----------|--------|-------------------|
| Context assembly | < 300ms | latency.context < 300 |
| LLM inference | < 1500ms | latency.llm < 1500 |
| TTS synthesis (1st byte) | < 500ms | latency.ttsFirstByte < 500 |
| Total response | < 2000ms | latency.total < 2000 |
| Input parsing | < 200ms | latency.parsing < 200 |
| Cost per response | < $0.02 | cost < 0.02 |

**Acceptance Criteria:**
- [ ] All 7 test scenarios pass
- [ ] Latency benchmarks meet targets (or documented as TBD with rationale)
- [ ] Isolation tests demonstrate zero cross-contamination
- [ ] Cost tracking accurate to within 5% of actual API costs
- [ ] Code coverage > 80%
- [ ] Concurrent user tests with 3+ users pass
- [ ] Graceful fallback tests pass (STT failure, TTS failure)
- [ ] All edge cases covered (empty input, malformed JSON, network timeouts)
- [ ] Integration tests runnable in CI/CD pipeline

**Notes:**
- Use mock services where appropriate (LLM, WKG, Drive Engine)
- Use real Grafeo instances for isolation tests
- Performance tests: run 3 times, report mean + stddev
- Consider test fixtures: pre-defined conversations, persons, knowledge

---

## Ticket Dependencies Summary

```
T001 (Types)
  ↓
T002 (Module & DI)
  ↓
T003 ← → T004 ← → T005 (Parser, Person, LLM - parallel)
  ↓         ↓       ↓
T006 (Response Gen) [needs all 3]
  ↓
T007 (Theater) ← → T008 ← → T009 (Validator, STT, TTS - parallel)
  ↓
T010 (Chatbox) [needs T003, T006]
  ↓
T011 (Social Contingency) [needs T010]
  ↓
T012 (Integration & benchmarks) [needs all]
```

**Critical Path:** T001 → T002 → T005 → T006 → T009 → T012 = ~13 days

**With parallelization:** ~18-21 days total

---

**End of ticket templates. Use these as starting points for detailed Jira/GitHub issues.**
