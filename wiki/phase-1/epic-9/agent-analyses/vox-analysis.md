# Epic 9: Dashboard API and WebSocket Gateways -- Vox Communication Engineer Analysis

**Status:** Planning Analysis
**Epic Scope:** Conversation REST API, Conversation WebSocket Gateway, Telemetry WebSocket, Voice I/O endpoints, Person model introspection, Theater enforcement in API layer
**Analysis Date:** 2026-03-29
**Analyzer:** Vox (Communication Engineer)

---

## Executive Summary

Epic 9 builds the **API surface** between the React frontend dashboard and the Communication subsystem (E6). This is where Sylphie's real-time conversational state becomes observable to the guardian, and where the guardian's text/voice input flows in to trigger communication events.

**Critical constraint:** The API layer is *not* where decisions happen. The API is the envelope. Input validation, context assembly, and response generation remain in CommunicationService (E6). The API layer:
- Routes messages between frontend and Communication subsystem
- Manages WebSocket connection state and session tracking
- Delivers live drive state and theater check results to the dashboard
- Ensures guardian input never bypasses Communication validation
- Exposes conversation history for review and learning

**What Epic 9 is NOT:**
- It does not implement voice processing (that's E6)
- It does not implement response generation (that's E6)
- It does not contain decision logic (that belongs to DecisionMakingModule)
- It does not create graph knowledge (that's the Learning subsystem)

---

## 1. Conversation Gateway Design (WebSocket)

### 1.1 Purpose and Scope

The **ConversationGateway** manages real-time bidirectional chat between guardian and Sylphie. It mediates three flows:

1. **Guardian Input Flow:** Text/voice input → CommunicationService.handleGuardianInput() → response back to WebSocket
2. **Drive State Broadcasting:** Drive Engine ticks → current drive state broadcast to all connected clients for this conversation
3. **Theater Check Feedback:** Response generation includes Theater validation result; frontend visualizes when Theater Prohibition was enforced

### 1.2 WebSocket Protocol

#### Connection Lifecycle

```
Guardian connects to:
  ws://localhost:3000/ws/conversation/{conversationId}?sessionId={sessionId}

Server validates:
  - sessionId is active and authenticated
  - conversationId exists and belongs to sessionId
  - If invalid, WebSocket closes with code 4001 (unauthorized)

On successful connection:
  - Server broadcasts snapshot: current drive state, last 10 messages, person model summary
  - Client enters "ready" state
```

#### Message Format: Incoming (Guardian → Sylphie)

```typescript
interface IncomingMessage {
  type: 'message' | 'feedback' | 'voice-chunk';

  // For 'message' type
  text?: string;                // Guardian's text input
  timestamp?: number;           // Client-side timestamp (for latency tracking)

  // For 'feedback' type (guardian correcting Sylphie)
  targetMessageId?: string;     // Reference to which Sylphie message is being corrected
  feedbackType?: 'correction' | 'confirmation' | 'approval';
  feedbackContent?: string;     // What the guardian wants to correct/confirm

  // For 'voice-chunk' type
  audioChunk?: Buffer;          // Audio frame from STT stream
  isFinal?: boolean;            // Last chunk of this utterance
}
```

**Flow:**
1. Guardian sends `{ type: 'message', text: 'Hello' }`
2. ConversationGateway validates and routes to `CommunicationService.handleGuardianInput()`
3. CommunicationService processes through InputParser, generates response, runs TheaterValidator
4. Response returned to ConversationGateway

#### Message Format: Outgoing (Sylphie → Guardian)

```typescript
interface OutgoingMessage {
  type: 'response' | 'system' | 'drive-update' | 'error';

  // For 'response' type
  messageId?: string;                    // Unique ID for this Sylphie message
  text?: string;                         // Sylphie's response text
  timestamp?: number;                    // Server-side generation timestamp

  // Theater enforcement result (always included for 'response' type)
  theaterCheck?: {
    isTheater: boolean;                  // Was this output gated by Theater Prohibition?
    driveCorrelation: {
      drive: string;                     // Which drive should correlate (e.g., "Curiosity")
      currentValue: number;              // Actual drive value [0, 1]
      requiredThreshold: number;         // Minimum value for authentic expression (e.g., 0.2)
      passed: boolean;                   // true = response is authentic, false = gated
    }[];
    gatingDecision?: 'accepted' | 'rewritten' | 'rejected';  // What happened
    originalText?: string;               // If rewritten, show what was changed
  };

  // Metadata for developer introspection
  metadata?: {
    responseLatencyMs: number;            // Time from input to response generation
    inputParsedAs: {
      intent: string;                    // Detected user intent
      confidence: number;
      entities: unknown[];
    };
    personModelUsed?: string;             // "jim" if Other KG for Jim was used
    type1Confidence?: number;             // If Type 1 was evaluated, its confidence
    type2Triggered?: boolean;             // Was LLM involved?
    llmTokensUsed?: number;
  };

  // For 'drive-update' type
  drives?: {
    [driveName: string]: number;         // Map of drive names to current values [0, 1]
  };
  timestamp?: number;

  // For 'system' type
  message?: string;

  // For 'error' type
  error?: string;
  errorCode?: string;
}
```

### 1.3 Session Management

#### Session Lifecycle

A **session** represents a guardian's authenticated connection to the system. A guardian can have multiple conversations within a session.

```typescript
interface SessionState {
  sessionId: string;                      // Unique session identifier
  guardianId: string;                     // Jim's authenticated user ID
  activeConversationId?: string;          // Which conversation is currently active
  connectedWebSockets: string[];          // IDs of WebSocket clients in this session
  authenticatedAt: number;                // Session start time
  lastActivityAt: number;                 // For heartbeat tracking
}

interface ConversationSession {
  conversationId: string;
  sessionId: string;                      // Foreign key to SessionState
  createdAt: number;
  messages: ConversationMessage[];        // Cached messages for fast access
  driveStateSnapshot: {
    timestamp: number;
    drives: { [name: string]: number };
  };
  personModel?: {
    entities: string[];                   // Key entities learned about guardian
    lastUpdated: number;
  };
}
```

#### Connection Tracking

When multiple WebSocket clients connect to the same conversation (e.g., guardian switches devices):

```typescript
// In ConversationGateway
private sessionConnections = new Map<string, Set<WebSocket>>();
private conversationConnections = new Map<string, Set<WebSocket>>();

onConnect(ws: WebSocket, conversationId: string, sessionId: string) {
  // Track which conversation this WebSocket serves
  if (!this.conversationConnections.has(conversationId)) {
    this.conversationConnections.set(conversationId, new Set());
  }
  this.conversationConnections.get(conversationId)!.add(ws);

  // Track which session this belongs to
  if (!this.sessionConnections.has(sessionId)) {
    this.sessionConnections.set(sessionId, new Set());
  }
  this.sessionConnections.get(sessionId)!.add(ws);

  // Broadcast initial snapshot to this client
  this.broadcastSnapshot(conversationId, ws);
}

onDisconnect(ws: WebSocket, conversationId: string, sessionId: string) {
  this.conversationConnections.get(conversationId)?.delete(ws);
  this.sessionConnections.get(sessionId)?.delete(ws);

  // If all WebSockets for this conversation disconnected, cleanup
  if (this.conversationConnections.get(conversationId)?.size === 0) {
    this.conversationConnections.delete(conversationId);
  }
}
```

### 1.4 Drive State Broadcasting

The ConversationGateway receives drive updates from the Drive Engine through TimescaleDB events. **Critical:** Do not cache stale drive state.

```typescript
// In ConversationGateway or a dedicated service
async broadcastDriveStateUpdate(drives: { [name: string]: number }) {
  // Send to ALL active conversations (all guardians see their own drive state)
  for (const [conversationId, webSockets] of this.conversationConnections) {
    const message: OutgoingMessage = {
      type: 'drive-update',
      drives,
      timestamp: Date.now(),
    };

    for (const ws of webSockets) {
      ws.send(JSON.stringify(message));
    }
  }
}

// Subscribe to drive update events from TimescaleDB
// Drives should be pushed every 500ms or on significant change (delta > 0.05)
onDriveEngineUpdate(event: DriveUpdateEvent) {
  const freshDrives = extractDrivesFromEvent(event);
  this.broadcastDriveStateUpdate(freshDrives);
}
```

### 1.5 Disconnect and Reconnection Handling

**Problem:** Guardian closes browser tab mid-conversation. What happens to pending responses?

**Solution:** Implement pending message queue per conversation.

```typescript
interface ConversationState {
  conversationId: string;
  pendingResponses: PendingResponse[];      // Responses generated while disconnected
  messageBuffer: OutgoingMessage[];         // Messages queued for delivery
}

interface PendingResponse {
  messageId: string;
  text: string;
  generatedAt: number;
  theaterCheck: TheaterCheckResult;
  delivered: boolean;
}

onGuardianInput(input: IncomingMessage, conversationId: string) {
  // Process input through CommunicationService
  const response = await this.communicationService.handleGuardianInput(input.text);

  // Store in pending queue
  const pendingResponse: PendingResponse = {
    messageId: generateId(),
    text: response.text,
    generatedAt: Date.now(),
    theaterCheck: response.theaterCheck,
    delivered: false,
  };

  const convState = this.getConversationState(conversationId);
  convState.pendingResponses.push(pendingResponse);

  // Try to deliver immediately
  const connected = this.conversationConnections.get(conversationId);
  if (connected && connected.size > 0) {
    this.deliverToConnected(pendingResponse, connected);
    pendingResponse.delivered = true;
  }

  // If no connected clients, messages wait in pending queue
  // On reconnection, flush pending messages to client
}

onReconnect(ws: WebSocket, conversationId: string) {
  const convState = this.getConversationState(conversationId);

  // Flush pending messages
  for (const pending of convState.pendingResponses.filter(p => !p.delivered)) {
    ws.send(JSON.stringify({
      type: 'response',
      ...pending,
    }));
    pending.delivered = true;
  }

  // Remove delivered messages
  convState.pendingResponses = convState.pendingResponses.filter(p => !p.delivered);
}
```

---

## 2. Conversation History API (REST)

### 2.1 Endpoint: GET /api/conversations/{conversationId}/messages

Retrieve paginated conversation history with metadata.

```typescript
// Request
interface GetConversationHistoryRequest {
  conversationId: string;
  limit?: number;              // Max 100, default 20
  offset?: number;             // Default 0 (most recent first)
  includeMetadata?: boolean;   // Default true
  includeTheaterChecks?: boolean; // Default true
}

// Response
interface GetConversationHistoryResponse {
  conversationId: string;
  messages: ConversationMessage[];
  totalCount: number;
  hasMore: boolean;            // Whether more messages exist
}

interface ConversationMessage {
  messageId: string;
  sender: 'guardian' | 'sylphie';
  text: string;
  timestamp: number;

  // Metadata for Sylphie messages
  metadata?: {
    responseLatencyMs: number;
    inputIntent: string;
    inputConfidence: number;
    type1Evaluated?: boolean;
    type1Confidence?: number;
    type2Triggered: boolean;
    llmTokensUsed?: number;
    personModelUsed?: string;
  };

  // Theater check result (if Sylphie message and includeTheaterChecks=true)
  theaterCheck?: TheaterCheckResult;

  // Guardian feedback on this message (if present)
  guardianFeedback?: {
    feedbackType: 'correction' | 'confirmation' | 'approval';
    content: string;
    timestamp: number;
  };
}

interface TheaterCheckResult {
  isTheater: boolean;
  driveCorrelation: {
    drive: string;
    currentValue: number;
    requiredThreshold: number;
    passed: boolean;
  }[];
  gatingDecision: 'accepted' | 'rewritten' | 'rejected';
  originalText?: string;      // If rewritten
}
```

**Implementation:**

```typescript
// src/communication/controllers/conversation-history.controller.ts
@Controller('api/conversations')
export class ConversationHistoryController {
  constructor(
    private readonly conversationService: ConversationService,
    private readonly eventsService: EventsService,
  ) {}

  @Get(':conversationId/messages')
  @UseGuards(SessionGuard)
  async getConversationHistory(
    @Param('conversationId') conversationId: string,
    @Query('limit') limit: number = 20,
    @Query('offset') offset: number = 0,
    @Query('includeMetadata') includeMetadata: boolean = true,
    @Query('includeTheaterChecks') includeTheaterChecks: boolean = true,
    @Session() session: SessionState,
  ): Promise<GetConversationHistoryResponse> {
    // Verify session owns this conversation
    const owns = await this.conversationService.sessionOwnsConversation(
      session.sessionId,
      conversationId,
    );
    if (!owns) throw new UnauthorizedException();

    // Query TimescaleDB for communication events
    const events = await this.eventsService.queryCommunicationEvents({
      conversationId,
      limit: limit + 1,  // +1 to detect hasMore
      offset,
      includeMetadata,
    });

    const hasMore = events.length > limit;
    const messages = events.slice(0, limit).map(event => ({
      messageId: event.messageId,
      sender: event.sender,
      text: event.text,
      timestamp: event.timestamp,
      metadata: includeMetadata ? event.metadata : undefined,
      theaterCheck: includeTheaterChecks ? event.theaterCheck : undefined,
      guardianFeedback: event.feedback,
    }));

    return {
      conversationId,
      messages,
      totalCount: await this.eventsService.countCommunicationEvents(conversationId),
      hasMore,
    };
  }
}
```

**Query from TimescaleDB:**

```sql
SELECT
  event_id as messageId,
  data->>'sender' as sender,
  data->>'text' as text,
  timestamp,
  data->'metadata' as metadata,
  data->'theaterCheck' as theaterCheck,
  data->'feedback' as feedback
FROM communication_events
WHERE conversation_id = $1
ORDER BY timestamp DESC
LIMIT $2 OFFSET $3;
```

### 2.2 Endpoint: GET /api/conversations

List all conversations for authenticated session.

```typescript
@Get('')
@UseGuards(SessionGuard)
async listConversations(
  @Query('limit') limit: number = 50,
  @Query('offset') offset: number = 0,
  @Session() session: SessionState,
): Promise<ConversationListResponse> {
  const conversations = await this.conversationService.listBySession(
    session.sessionId,
    limit,
    offset,
  );

  return {
    conversations: conversations.map(conv => ({
      conversationId: conv.id,
      createdAt: conv.createdAt,
      messageCount: conv.messageCount,
      lastMessageAt: conv.lastMessageAt,
      lastMessagePreview: conv.lastMessage?.text.slice(0, 100),
      personModelSummary: {
        keyEntities: conv.personModel?.keyEntities || [],
        lastUpdated: conv.personModel?.lastUpdated,
      },
    })),
    totalCount: await this.conversationService.countBySession(session.sessionId),
    hasMore: conversations.length > limit,
  };
}
```

---

## 3. Theater Prohibition in API Layer

### 3.1 Theater Check Enforcement

**The Theater Prohibition (CANON Immutable Standard 1):** Any output must correlate with actual drive state. If Sylphie's Curiosity is 0.1 and the response expresses high curiosity, it's theater. The API layer does not enforce this -- that's ResponseGeneratorService.TheaterValidatorService. But the API layer **must expose the check result** so the frontend can visualize when Theater was enforced.

### 3.2 Response Format with Theater Data

Every `response` type message from the ConversationGateway includes `theaterCheck`:

```typescript
interface OutgoingMessage {
  type: 'response';
  messageId: string;
  text: string;                // May be rewritten from LLM output if theater was detected
  theaterCheck: {
    isTheater: boolean;        // true = response violated drive correlation
    driveCorrelation: {
      drive: string;           // Drive that should correlate (e.g., "Curiosity")
      currentValue: number;    // Actual drive value from Drive Engine
      requiredThreshold: number; // Minimum required [0, 1]
      passed: boolean;         // true = drive >= threshold, acceptable
    }[];                       // May be multiple drives checked

    gatingDecision: 'accepted' | 'rewritten' | 'rejected';
    originalText?: string;     // If rewritten, what did the LLM initially produce?
  };
}
```

### 3.3 Frontend Visualization

The dashboard displays Theater violations:

```typescript
// In frontend
if (message.theaterCheck && !message.theaterCheck.isTheater) {
  // Response passed Theater check, show normally
  renderMessage(message.text);
} else if (message.theaterCheck?.gatingDecision === 'rewritten') {
  // Response was rewritten; show diff
  renderMessage(message.text);
  showAnnotation(`Original: "${message.theaterCheck.originalText}"`);
  showAnnotation(`Theater violation detected (${correlationFailure}); response rewritten`);
} else if (message.theaterCheck?.gatingDecision === 'rejected') {
  // Response was rejected entirely
  showAnnotation(`Theater violation detected; response suppressed`);
  // Maybe show: "Sylphie wanted to say: '...' but her Curiosity was too low"
}
```

This keeps the guardian informed about when the system enforced its own constraints.

---

## 4. Voice Endpoints (E6 or E9?)

### 4.1 Architectural Decision

Voice I/O (STT/TTS) is conceptually part of **Communication (E6)** because:
- Speech recognition is input parsing
- Speech synthesis is output generation
- Both flow through CommunicationService

However, the **API endpoints** that expose these to the frontend belong in **E9 (Dashboard API)** because:
- The frontend needs to upload audio and download audio
- Sessions need to manage voice stream state
- HTTP/WebSocket routing is an API concern

**Decision:** E6 implements the services; E9 exposes the HTTP endpoints.

### 4.2 Endpoint: POST /api/voice/transcribe

Upload audio chunk → STT → return recognized text.

```typescript
interface TranscribeRequest {
  audioBlob: Blob;             // WAV or OGG
  conversationId: string;
}

interface TranscribeResponse {
  text: string;                // Recognized text
  confidence: number;          // STT confidence [0, 1]
  isFinal: boolean;            // true = speech ended, false = still listening
  audioProcessingMs: number;   // Time to transcribe
}

@Post('voice/transcribe')
@UseGuards(SessionGuard)
async transcribeAudio(
  @Body() body: TranscribeRequest,
  @Session() session: SessionState,
): Promise<TranscribeResponse> {
  const { audioBlob, conversationId } = body;

  // Verify session owns conversation
  const owns = await this.conversationService.sessionOwnsConversation(
    session.sessionId,
    conversationId,
  );
  if (!owns) throw new UnauthorizedException();

  // Call STT service
  const startTime = Date.now();
  const result = await this.sttService.transcribe(audioBlob);

  return {
    text: result.text,
    confidence: result.confidence,
    isFinal: result.isFinal,
    audioProcessingMs: Date.now() - startTime,
  };
}
```

### 4.3 Endpoint: POST /api/voice/synthesize

Text → TTS → return audio download URL.

```typescript
interface SynthesizeRequest {
  text: string;
  voice?: 'default' | 'variant-a' | 'variant-b';  // TTS voice options
  conversationId: string;
}

interface SynthesizeResponse {
  audioUrl: string;            // Signed URL to download audio file
  durationMs: number;          // Audio duration
  voiceUsed: string;
  synthesisTimeMs: number;
}

@Post('voice/synthesize')
@UseGuards(SessionGuard)
async synthesizeAudio(
  @Body() body: SynthesizeRequest,
  @Session() session: SessionState,
): Promise<SynthesizeResponse> {
  const { text, voice = 'default', conversationId } = body;

  // Verify session owns conversation
  const owns = await this.conversationService.sessionOwnsConversation(
    session.sessionId,
    conversationId,
  );
  if (!owns) throw new UnauthorizedException();

  // Call TTS service
  const startTime = Date.now();
  const audioBuffer = await this.ttsService.synthesize(text, voice);

  // Store audio file temporarily (e.g., in S3)
  const fileUrl = await this.storageService.uploadTemporaryAudio(
    audioBuffer,
    `${conversationId}-${Date.now()}.mp3`,
  );

  return {
    audioUrl: fileUrl,
    durationMs: audioBuffer.duration,
    voiceUsed: voice,
    synthesisTimeMs: Date.now() - startTime,
  };
}
```

**Note:** Audio files should be temporary (expire after 30 mins) to avoid storage bloat.

---

## 5. Telemetry WebSocket (Communication Events)

### 5.1 Purpose

A separate WebSocket stream for high-frequency communication telemetry. This is distinct from ConversationGateway; it's for debugging/monitoring, not for the active conversation.

```
ws://localhost:3000/ws/telemetry?sessionId={sessionId}
```

### 5.2 Telemetry Message Format

```typescript
interface TelemetryEvent {
  type: 'input-parsed' | 'response-generated' | 'theater-check' | 'voice-activity' | 'person-model-update';
  timestamp: number;
  conversationId: string;

  // For 'input-parsed'
  inputText?: string;
  detectedIntent?: string;
  intentConfidence?: number;
  entities?: unknown[];
  parsingLatencyMs?: number;

  // For 'response-generated'
  responseText?: string;
  responseLatencyMs?: number;
  type1Evaluated?: boolean;
  type1Confidence?: number;
  type2Triggered?: boolean;
  llmTokensUsed?: number;

  // For 'theater-check'
  theaterCheck?: TheaterCheckResult;

  // For 'voice-activity'
  voiceActivityLevel?: number;  // [0, 1]
  isSpeaking?: boolean;

  // For 'person-model-update'
  personModelChanges?: {
    newEntities?: string[];
    updatedEdges?: number;
  };
}
```

### 5.3 Telemetry Event Flow

The **Learning subsystem** and **Communication subsystem** write telemetry events to TimescaleDB with tag `event_type = 'telemetry'`. The TelemetryGateway queries these in real-time and broadcasts to connected clients:

```typescript
@WebSocketGateway({
  namespace: '/ws/telemetry',
  cors: { origin: '*' },
})
export class TelemetryGateway {
  @OnGatewayConnection()
  async handleConnection(client: Socket) {
    const sessionId = client.handshake.query.sessionId;

    // Validate session
    const isValid = await this.sessionService.validateSession(sessionId);
    if (!isValid) {
      client.disconnect();
      return;
    }

    // Subscribe to telemetry stream for this session
    this.subscribeToTelemetryStream(sessionId, client);
  }

  private subscribeToTelemetryStream(sessionId: string, client: Socket) {
    // Poll TimescaleDB for new telemetry events
    // Or use pub/sub if TimescaleDB supports it
    const subscription = this.eventsService.subscribeTelemetry(sessionId);

    subscription.on('event', (event: TelemetryEvent) => {
      client.emit('telemetry', event);
    });

    client.on('disconnect', () => {
      subscription.unsubscribe();
    });
  }
}
```

---

## 6. Person Model API (Read-Only Introspection)

### 6.1 Design Question: Expose Other KGs?

**CANON constraint:** "Self KG and Other KG (Grafeo) are completely isolated from each other and from the WKG. No shared edges, no cross-contamination."

**Decision:** Person model data should be read-only and **summarized**, not exposed raw.

### 6.2 Endpoint: GET /api/person-models/{personId}/summary

```typescript
interface PersonModelSummary {
  personId: string;  // e.g., "jim"

  // Key entities Sylphie has learned about this person
  keyEntities: {
    entityName: string;
    entityType: string;       // "preference", "fact", "behavior", etc.
    confidence: number;
    provenance: 'GUARDIAN' | 'LLM_GENERATED' | 'INFERENCE';
    source?: string;          // Which event led to this belief?
  }[];

  // Behavioral patterns
  patterns: {
    patternName: string;      // e.g., "responds-quickly-to-morning-messages"
    frequency: number;        // [0, 1]
    confidence: number;
    exampleDates: number[];   // Timestamps where pattern was observed
  }[];

  // Communication preferences learned
  communicationStyle: {
    preferredTone?: string;   // "formal", "casual", "playful"
    typicalResponseTime?: number; // ms
    engagementLevel?: number; // [0, 1]
  };

  // Last update and growth metrics
  lastUpdated: number;
  totalEdgesLearned: number;
  guardianConfirmedEdges: number;
  llmGeneratedEdges: number;
  inferenceEdges: number;
}

@Get('person-models/:personId/summary')
@UseGuards(SessionGuard)
async getPersonModelSummary(
  @Param('personId') personId: string,
  @Session() session: SessionState,
): Promise<PersonModelSummary> {
  // Verify this session is the person being modeled
  // (Jim can only see his own model)
  if (personId !== 'jim') throw new ForbiddenException();

  const summary = await this.personModelingService.getSummary(personId);
  return summary;
}
```

**Implementation Notes:**

- Raw edges from the Other KG are NOT exposed -- only summaries
- Summaries are computed on-demand (or cached with short TTL)
- Guardian can see what Sylphie believes about them, but not the raw graph
- This serves the dual purpose of: (a) letting Jim verify Sylphie's models are accurate, and (b) giving us insight into what Sylphie is learning

---

## 7. Real-time Communication Events (Telemetry WebSocket Detailed)

### 7.1 Event Types to Stream

```
Input Parsing Events:
  - input-received
  - intent-detected
  - input-confidence-[high|medium|low]

Response Generation Events:
  - response-generated
  - response-latency-[fast|normal|slow]
  - type1-evaluated
  - type1-confidence-[high|medium|low]
  - type2-triggered
  - llm-tokens-consumed

Theater Enforcement Events:
  - theater-check-passed
  - theater-check-failed-[drive-name]
  - theater-gating-[accepted|rewritten|rejected]

Person Model Events:
  - person-model-updated
  - new-entity-learned
  - edge-confidence-increased

Voice Activity Events:
  - voice-started
  - voice-ended
  - transcription-confidence-[high|medium|low]
```

### 7.2 Example: Social Drive Contingency Timing

When Sylphie makes a comment and receives guardian feedback:

```typescript
// Timeline written to TimescaleDB
[t+0ms]   input-received: { text: "Did you see that interesting article?" }
[t+45ms]  intent-detected: { intent: "social-comment", confidence: 0.92 }
[t+150ms] response-generated: { text: "What did you think?" }
[t+200ms] theater-check-passed: { driveCorrelation: [ { drive: "Social", value: 0.65, passed: true } ] }
[t+2000ms] guardian-responded: { responseTime: 1800, sentiment: "engaged" }
[t+2010ms] social-drive-relief: { amount: 0.15, timestamp: 2010 }  // Within 30s = extra reinforcement
```

Frontend visualizes this timeline in a chart for debugging and verification.

---

## 8. Risks and Mitigations

### 8.1 Chat Input Bypassing Communication Module

**Risk:** Frontend sends text directly to ConversationGateway without going through CommunicationService.

**Mitigation:**
- ConversationGateway delegates ALL processing to CommunicationService
- Never parse or interpret input in the Gateway
- Gateway routes, periods

```typescript
// CORRECT
async handleIncomingMessage(msg: IncomingMessage) {
  const response = await this.communicationService.handleGuardianInput(msg.text);
  this.broadcastResponse(response);
}

// WRONG - don't do this
async handleIncomingMessage(msg: IncomingMessage) {
  if (msg.text.includes("hello")) {
    this.broadcast("Hello there!");  // Bypassed Communication!
  }
}
```

### 8.2 Stale Drive State in API Responses

**Risk:** API includes drive state from 5 seconds ago; frontend visualizes outdated state.

**Mitigation:**
- Never cache drive state in API layer
- Query fresh values on every request
- Use WebSocket for push updates instead of pull
- Include timestamp with every drive value

```typescript
// GOOD: Fresh drive state
@Get('current-state')
async getCurrentState(@Session() session: SessionState) {
  const drives = await this.driveEngineService.getCurrentDrives();  // Fresh
  return {
    drives,
    timestamp: Date.now(),
  };
}

// BAD: Cached drive state
private cachedDrives = {};

@Get('current-state')
async getCurrentState(@Session() session: SessionState) {
  return this.cachedDrives;  // Stale!
}
```

### 8.3 WebSocket Message Ordering

**Risk:** Messages arrive out of order, frontend displays conversation in wrong sequence.

**Mitigation:**
- Assign message IDs on server side (not client side)
- Include sequence number or timestamp in every message
- Frontend sorts by timestamp if received out of order

```typescript
interface OutgoingMessage {
  messageId: string;          // Server-generated UUID
  sequenceNumber: number;     // Monotonically increasing
  timestamp: number;          // Server-generated, not client-provided
}

// On frontend
const messages = receivedMessages.sort((a, b) => a.timestamp - b.timestamp);
```

### 8.4 Connection State Leaks

**Risk:** WebSocket connection closes; pending state isn't cleaned up; memory leak.

**Mitigation:**
- Use NestJS Gateway decorators properly
- Implement connection/disconnect lifecycle hooks
- Clean up subscriptions and state on disconnect
- Set timeouts for inactive sessions

```typescript
@WebSocketGateway()
export class ConversationGateway {
  private activeConnections = new Map<string, Socket>();

  @OnGatewayConnection()
  handleConnection(client: Socket) {
    this.activeConnections.set(client.id, client);
  }

  @OnGatewayDisconnect()
  handleDisconnect(client: Socket) {
    this.activeConnections.delete(client.id);

    // Clean up any pending messages for this client
    const conversationId = this.getConversationId(client);
    this.cleanupPendingMessages(conversationId, client.id);
  }

  // Periodic cleanup (every 5 mins)
  @Interval(5 * 60 * 1000)
  cleanupInactiveConnections() {
    const now = Date.now();
    for (const [id, client] of this.activeConnections) {
      if (now - client.handshake.issued > 1 * 60 * 60 * 1000) {  // 1 hour
        client.disconnect();
      }
    }
  }
}
```

### 8.5 Theater Check Result Not Reaching Frontend

**Risk:** Response is rewritten by Theater validator, but the original text is lost; frontend can't show the diff.

**Mitigation:**
- TheaterValidatorService always returns `originalText` when rewriting
- API layer never strips this data
- Frontend displays diff when gatingDecision is 'rewritten'

```typescript
// In ResponseGeneratorService
const response = await this.llmService.generate(context);

const theaterResult = await this.theaterValidator.check(response, currentDrives);

if (theaterResult.gatingDecision === 'rewritten') {
  return {
    text: theaterResult.rewrittenText,
    theaterCheck: {
      isTheater: true,
      gatingDecision: 'rewritten',
      originalText: response.text,  // KEEP ORIGINAL
      driveCorrelation: theaterResult.driveCorrelation,
    },
  };
}
```

### 8.6 Telemetry Overwhelms Database

**Risk:** Telemetry events accumulate at 100+ events/second; TimescaleDB grows uncontrollably.

**Mitigation:**
- Aggressive compression: only write high-priority events
- Aggregate low-priority events (e.g., per-second summaries)
- Set retention policy: telemetry older than 7 days is deleted

```sql
-- In TimescaleDB setup
SELECT add_retention_policy('telemetry_events', INTERVAL '7 days');

-- Create hypertable with compression
SELECT create_hypertable('telemetry_events', 'timestamp', if_not_exists => TRUE);
ALTER TABLE telemetry_events SET (
  timescaledb.compress,
  timescaledb.compress_orderby = 'timestamp DESC'
);

SELECT add_compression_policy('telemetry_events', INTERVAL '1 day');
```

---

## 9. Data Flow Diagrams

### 9.1 Guardian Input Flow

```
┌─────────────────────────────────────────────────────────────┐
│ Frontend (React)                                            │
│ - User types "Hello"                                        │
│ - Click "Send"                                              │
└────────────────────┬────────────────────────────────────────┘
                     │
                     v (WebSocket)
┌─────────────────────────────────────────────────────────────┐
│ ConversationGateway (E9)                                    │
│ - Receive IncomingMessage { type: 'message', text: '...' }  │
│ - Validate session, conversation ownership                  │
│ - Route to CommunicationService (E6)                        │
└────────────────────┬────────────────────────────────────────┘
                     │
                     v
┌─────────────────────────────────────────────────────────────┐
│ CommunicationService.handleGuardianInput() (E6)             │
│ - InputParser.parse()                                       │
│ - Query WKG for context                                     │
│ - Query TimescaleDB for conversation history               │
│ - LlmContextAssembler.build()                               │
│ - LlmService.generate() [Type 2]                            │
│ - TheaterValidator.check()                                  │
│ - Return response with theaterCheck result                  │
└────────────────────┬────────────────────────────────────────┘
                     │
                     v (back through gateway)
┌─────────────────────────────────────────────────────────────┐
│ ConversationGateway (E9)                                    │
│ - Assemble OutgoingMessage with theaterCheck               │
│ - Broadcast to all connected WebSocket clients             │
│ - Store in pending queue                                    │
└────────────────────┬────────────────────────────────────────┘
                     │
                     v (WebSocket)
┌─────────────────────────────────────────────────────────────┐
│ Frontend                                                    │
│ - Receive OutgoingMessage                                   │
│ - Display Sylphie's response                                │
│ - Show theaterCheck.gatingDecision if not 'accepted'       │
└─────────────────────────────────────────────────────────────┘
```

### 9.2 Drive State Broadcast Flow

```
┌─────────────────────────────────────────────────────────────┐
│ Drive Engine (E4) -- separate process                       │
│ - Tick: compute drives                                      │
│ - Write to TimescaleDB                                      │
└────────────────────┬────────────────────────────────────────┘
                     │
                     v
┌─────────────────────────────────────────────────────────────┐
│ TimescaleDB                                                 │
│ - Store drive_tick event with drive values                  │
└────────────────────┬────────────────────────────────────────┘
                     │
                     v
┌─────────────────────────────────────────────────────────────┐
│ ConversationGateway (E9)                                    │
│ - Subscribe to drive tick events (or poll every 500ms)     │
│ - Assemble OutgoingMessage { type: 'drive-update', ... }   │
│ - Broadcast to all connected WebSocket clients             │
└────────────────────┬────────────────────────────────────────┘
                     │
                     v (WebSocket push)
┌─────────────────────────────────────────────────────────────┐
│ Frontend                                                    │
│ - Update drive state visualization                          │
│ - Re-render drive meters                                    │
└─────────────────────────────────────────────────────────────┘
```

### 9.3 Conversation History Query Flow

```
┌─────────────────────────────────────────────────────────────┐
│ Frontend                                                    │
│ - GET /api/conversations/{id}/messages?limit=20&offset=0   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     v (HTTP)
┌─────────────────────────────────────────────────────────────┐
│ ConversationHistoryController (E9)                          │
│ - Validate session ownership                                │
│ - Call EventsService.queryCommunicationEvents()            │
└────────────────────┬────────────────────────────────────────┘
                     │
                     v
┌─────────────────────────────────────────────────────────────┐
│ TimescaleDB                                                 │
│ SELECT * FROM communication_events                          │
│ WHERE conversation_id = $1 ORDER BY timestamp DESC LIMIT... │
└────────────────────┬────────────────────────────────────────┘
                     │
                     v
┌─────────────────────────────────────────────────────────────┐
│ ConversationHistoryController (E9)                          │
│ - Format events into ConversationMessage[]                  │
│ - Include theaterCheck, metadata, feedback                  │
│ - Return HTTP response                                      │
└────────────────────┬────────────────────────────────────────┘
                     │
                     v (HTTP JSON)
┌─────────────────────────────────────────────────────────────┐
│ Frontend                                                    │
│ - Render conversation history                               │
│ - Show theater violations as annotations                    │
└─────────────────────────────────────────────────────────────┘
```

---

## 10. API Contract Summary Table

| Endpoint | Method | Purpose | Returns | WebSocket? |
|----------|--------|---------|---------|-----------|
| `/ws/conversation/{conversationId}` | WS | Real-time chat | OutgoingMessage | Yes |
| `/api/conversations/{id}/messages` | GET | History | ConversationMessage[] | No |
| `/api/conversations` | GET | List conversations | ConversationListResponse | No |
| `/api/person-models/{personId}/summary` | GET | Person model introspection | PersonModelSummary | No |
| `/api/voice/transcribe` | POST | Audio → text | TranscribeResponse | No |
| `/api/voice/synthesize` | POST | Text → audio | SynthesizeResponse | No |
| `/ws/telemetry` | WS | Communication events | TelemetryEvent | Yes |

---

## 11. Known Gotchas for Next Session

### 11.1 Session Validation Everywhere

Every endpoint and WebSocket handler must validate that the authenticated session owns the conversation/person-model being accessed. Don't assume the guardian is valid just because they authenticated once.

### 11.2 Theater Check Must Be Fresh

Don't cache theater check results. They depend on current drive state, which changes every 500ms. Always recompute.

### 11.3 WebSocket Ordering

Messages can arrive out of order from the network. Use sequence numbers or timestamps to recover order on the frontend. Don't rely on delivery order.

### 11.4 Pending Message Queue Size

If a conversation generates responses faster than the guardian can read them, the pending queue grows. Set a max size (e.g., 500 messages) and drop old pending messages if exceeded.

### 11.5 Drive State Broadcast Frequency

If you broadcast drive state every tick (every few ms), you'll overwhelm the WebSocket. Batch updates or only broadcast when delta > 0.05. Tune based on frontend performance.

### 11.6 Person Model Summaries Are Computed, Not Cached

Computing a person model summary from raw Other KG data is expensive. Cache the summary with a 5-minute TTL, but don't keep it longer than that. Drive state and person model confidence can change frequently.

### 11.7 Audio File Cleanup

Synthesized audio files pile up in storage. Set an S3/cloud storage lifecycle policy to delete files older than 30 minutes. Include a background job to clean up orphaned files.

### 11.8 Theater Validation Happens After LLM

The LLM runs first (expensive). Then the response is validated against drive state. If theater is detected, you've wasted tokens. This is acceptable because theater violations should be rare. If they're common, it's a sign the LLM context assembly isn't injecting drive state properly.

---

## 12. Integration Points with Other Subsystems

| Subsystem | Integration Point | E9 Role |
|-----------|-------------------|---------|
| E6 (Communication) | ConversationGateway delegates to CommunicationService | Routes and broadcasts |
| E2 (Events / TimescaleDB) | Query conversation history and telemetry | Read-only subscriber |
| E4 (Drive Engine) | Read current drive state for broadcast | Read-only subscriber |
| E3 (Knowledge / WKG) | Query for context assembly (via E6) | Transparent passthrough |
| E5 (Planning) | No direct dependency | Telemetry subscriber (optional) |
| Frontend (React) | WebSocket gateway and REST API | Bidirectional |

---

## 13. Type Definitions (TypeScript Sketches)

See sections 2-6 above for full interface definitions. Key types:

- `IncomingMessage` -- Guardian input
- `OutgoingMessage` -- Sylphie output
- `ConversationMessage` -- History record
- `TheaterCheckResult` -- Theater enforcement result
- `TelemetryEvent` -- Communication telemetry
- `PersonModelSummary` -- Person model introspection
- `SessionState` -- Session tracking
- `ConversationSession` -- Conversation state

---

## 14. Next Steps for Implementation

1. **Stub out E9 module structure:** Create NestJS module, controllers, gateways, and service skeleton
2. **Implement ConversationGateway:** WebSocket connection, message routing to CommunicationService
3. **Implement ConversationHistoryController:** Query TimescaleDB, format responses
4. **Implement DriveStateGateway:** Subscribe to drive updates, broadcast to clients
5. **Implement VoiceController:** Expose STT/TTS endpoints
6. **Implement PersonModelController:** Read-only person model summaries
7. **Implement TelemetryGateway:** Stream communication events to interested clients
8. **Add session/authentication middleware:** Protect all endpoints and WebSocket routes
9. **Add error handling:** Graceful degradation for WebSocket disconnections, missing conversations, etc.
10. **Test connection lifecycle:** Multiple clients, reconnections, pending message delivery

---

## 15. Risks Summary

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Chat input bypasses Communication module | High | Gateway delegates all input to CommunicationService |
| Stale drive state in responses | High | Always query fresh, use push not pull |
| WebSocket message ordering | Medium | Sequence numbers, timestamp sorting |
| Connection state leaks | Medium | Proper lifecycle hooks, connection cleanup |
| Theater check result lost | Medium | Always preserve originalText in response |
| Telemetry overwhelming DB | Medium | Compression, retention policy, aggregation |
| Person model exposed raw | Low | Summarize, never expose raw edges |
| Audio file storage bloat | Low | Lifecycle policy, background cleanup |

---

## 16. Success Criteria

Epic 9 is complete when:

1. ConversationGateway handles WebSocket connections, routes input to CommunicationService, broadcasts responses
2. Drive state is broadcast every 500ms (or on delta > 0.05)
3. Theater check results are included in every response message
4. Conversation history can be paginated and includes metadata
5. Guardian can retrieve person model summary (read-only)
6. Voice endpoints (transcribe, synthesize) work end-to-end
7. Telemetry WebSocket streams communication events
8. All endpoints validate session ownership
9. WebSocket disconnections are handled gracefully (pending messages queued)
10. No message from Guardian bypasses CommunicationService.handleGuardianInput()

---

**Created by:** Vox, Communication Engineer
**Date:** 2026-03-29
**Status:** Analysis ready for Epic 9 implementation planning

This analysis provides the API contract, data flow, and architectural patterns for the Dashboard API and WebSocket gateways. Implementation teams should validate against these specs before writing code.
