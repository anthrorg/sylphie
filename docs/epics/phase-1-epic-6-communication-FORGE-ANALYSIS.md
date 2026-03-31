# Epic 6: Communication (Input/Output + Person Modeling) -- Forge Architectural Analysis

**Status:** Planning
**Epic Scope:** Input parsing, LLM-mediated response generation, person modeling, theater validation, voice I/O (STT/TTS), chatbox output
**Analysis Date:** 2026-03-29
**Analyzer:** Forge (NestJS/TypeScript Systems Architect)

---

## Executive Summary

Epic 6 builds the **Communication subsystem** as a NestJS module that handles all input interpretation and output generation. This is the subsystem where Sylphie's LLM voice is implemented -- but critically, **the LLM must remain the translator, not the thinker.**

The architecture must prevent:
1. **Theater violations** -- responses that don't correlate with actual drive state
2. **LLM decision-making** -- the LLM context-assembles but does not choose actions; decision making belongs to DecisionMakingModule
3. **Person model contamination** -- person models (Other KGs) must be isolated from the WKG
4. **Provenance laundering** -- LLM-generated content must retain LLM_GENERATED provenance tags
5. **Voice dependency coupling** -- if TTS/STT fails, graceful degradation to text-only mode

The Communication subsystem depends on:
- **E2 (Events)** -- writes conversation events, input/output records
- **E3 (Knowledge)** -- queries WKG for context, reads/writes Other KGs for person modeling
- **E4 (Drive Engine)** -- reads current drive state (read-only) to ensure responses correlate with actual emotional state

This analysis covers module structure, interface contracts, dependency injection, configuration, error handling, async patterns, anti-patterns, and ticket breakdown.

---

## 1. Module Structure & Directory Layout

### 1.1 Directory Tree

```
src/communication/
├── communication.module.ts              # Module declaration, imports/exports
├── communication.service.ts             # Public facade for other subsystems
├── input-parser/
│   ├── input-parser.service.ts         # Parses text/voice into structured input
│   ├── intent-extractor.service.ts     # Identifies user intent from input
│   └── input-parser.interfaces.ts      # Input-specific types
├── response-generator/
│   ├── response-generator.service.ts   # Assembles LLM context, calls LLM, validates output
│   ├── llm-context-assembler.service.ts # Builds Type 2 context: drive state, world knowledge, memory
│   ├── theater-validator.service.ts    # Ensures response correlates with drive state (Immutable Standard 1)
│   └── response-generator.interfaces.ts
├── person-modeling/
│   ├── person-modeling.service.ts      # Per-person Other KG management
│   ├── person-profile-extractor.service.ts # Learns about people from interaction
│   └── person-modeling.interfaces.ts
├── llm/
│   ├── llm.service.ts                  # Anthropic Claude API integration (Type 2 deliberation)
│   └── llm.interfaces.ts
├── voice/
│   ├── stt.service.ts                  # Speech-to-text (OpenAI Whisper)
│   ├── tts.service.ts                  # Text-to-speech (OpenAI TTS)
│   ├── voice-gateway.service.ts        # Manages voice stream lifecycle, fallback to text
│   └── voice.interfaces.ts
├── chatbox/
│   ├── chatbox.service.ts              # HTTP/WebSocket output to UI
│   └── chatbox.interfaces.ts
├── interfaces/
│   ├── communication.interfaces.ts      # Top-level public interfaces
│   └── communication.tokens.ts          # DI injection tokens
├── exceptions/
│   └── communication.exceptions.ts      # Domain-specific errors
├── index.ts                             # Barrel exports
└── README.md                            # Module documentation
```

### 1.2 Module Declaration

```typescript
// src/communication/communication.module.ts
import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommunicationService } from './communication.service.ts';
import { InputParserService } from './input-parser/input-parser.service';
import { ResponseGeneratorService } from './response-generator/response-generator.service';
import { LlmContextAssemblerService } from './response-generator/llm-context-assembler.service';
import { TheaterValidatorService } from './response-generator/theater-validator.service';
import { PersonModelingService } from './person-modeling/person-modeling.service';
import { PersonProfileExtractorService } from './person-modeling/person-profile-extractor.service';
import { LlmService } from './llm/llm.service';
import { SttService } from './voice/stt.service';
import { TtsService } from './voice/tts.service';
import { VoiceGatewayService } from './voice/voice-gateway.service';
import { ChatboxService } from './chatbox/chatbox.service';
import { COMMUNICATION_SERVICE, LLM_SERVICE, INPUT_PARSER_SERVICE, RESPONSE_GENERATOR_SERVICE, PERSON_MODELING_SERVICE, VOICE_GATEWAY_SERVICE, CHATBOX_SERVICE } from './interfaces/communication.tokens';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { EventsModule } from '../events/events.module';
// DriveEngineModule imported as read-only; we only read drive state
import { DriveEngineModule } from '../drive-engine/drive-engine.module';

@Module({
  imports: [
    ConfigModule,
    KnowledgeModule,      // For WKG context queries, Other KG person models
    EventsModule,         // For emitting communication events
    DriveEngineModule,    // For reading drive state (read-only)
  ],
  providers: [
    // Input handling
    InputParserService,
    {
      provide: INPUT_PARSER_SERVICE,
      useClass: InputParserService,
    },

    // Response generation pipeline
    LlmService,
    {
      provide: LLM_SERVICE,
      useClass: LlmService,
    },
    LlmContextAssemblerService,
    TheaterValidatorService,
    ResponseGeneratorService,
    {
      provide: RESPONSE_GENERATOR_SERVICE,
      useClass: ResponseGeneratorService,
    },

    // Person modeling
    PersonProfileExtractorService,
    PersonModelingService,
    {
      provide: PERSON_MODELING_SERVICE,
      useClass: PersonModelingService,
    },

    // Voice I/O
    SttService,
    TtsService,
    VoiceGatewayService,
    {
      provide: VOICE_GATEWAY_SERVICE,
      useClass: VoiceGatewayService,
    },

    // Chatbox output
    ChatboxService,
    {
      provide: CHATBOX_SERVICE,
      useClass: ChatboxService,
    },

    // Public facade
    CommunicationService,
    {
      provide: COMMUNICATION_SERVICE,
      useClass: CommunicationService,
    },
  ],
  exports: [
    COMMUNICATION_SERVICE,
    VOICE_GATEWAY_SERVICE,  // For dashboard voice stream management
    CHATBOX_SERVICE,        // For dashboard message display
  ],
})
export class CommunicationModule {}
```

---

## 2. Interface Contracts

### 2.1 Core Input/Output Interfaces

```typescript
// src/communication/interfaces/communication.interfaces.ts

import { Observable } from 'rxjs';

/**
 * Structured representation of parsed user input.
 * Carries provenance: where this input came from (voice, chatbox, API).
 */
export interface ParsedInput {
  readonly rawText: string;
  readonly intent: UserIntent;
  readonly entities: ExtractedEntity[];
  readonly confidence: number;
  readonly source: 'VOICE' | 'CHATBOX' | 'API';
  readonly timestamp: Date;
  readonly personId: string; // e.g., "Person_Jim"
  readonly conversationId: string; // Session ID for conversation context
}

export type UserIntent =
  | 'QUERY'           // "What do you know about X?"
  | 'STATEMENT'       // "I just saw a cat"
  | 'COMMAND'         // "Go to the kitchen"
  | 'CORRECTION'      // "That was wrong, actually X is Y"
  | 'AFFIRMATION'     // "Yes, that's right"
  | 'GREETING'        // "Hi!"
  | 'UNKNOWN';        // Could not parse intent

export interface ExtractedEntity {
  readonly label: string;
  readonly type: string;
  readonly properties: Record<string, unknown>;
}

/**
 * Structured response from the Communication subsystem.
 * Ready for delivery via voice, text, or both.
 * Must correlate with actual drive state (Theater Prohibition).
 */
export interface CommunicationResponse {
  readonly text: string;
  readonly driveState: DriveVector; // Snapshot of state when response was generated
  readonly confidence: number; // How confident is this response? (0.0-1.0)
  readonly personId: string;
  readonly conversationId: string;
  readonly timestamp: Date;
  readonly provenance: 'REFLEXIVE' | 'DELIBERATED'; // Type 1 vs Type 2
  readonly shouldSpeakAloud: boolean; // TTS or silent
}

/**
 * Input parser service interface.
 * Converts raw text/voice into structured input with intent and entities.
 */
export interface IInputParserService {
  /**
   * Parse raw text into structured input.
   * Queries WKG for context (recent conversation, known entities).
   * Extracts intent and entities using lightweight heuristics or LLM.
   * @throws InputParsingException if parsing fails (malformed input, external service error)
   */
  parseTextInput(rawText: string, personId: string, conversationId: string): Promise<ParsedInput>;

  /**
   * Parse voice bytes (raw audio) into text, then structured input.
   * Delegates to SttService for speech-to-text, then parseTextInput.
   * @throws InputParsingException if STT fails or text parsing fails
   */
  parseVoiceInput(audioBytes: Buffer, personId: string, conversationId: string): Promise<ParsedInput>;
}

/**
 * Response generator service interface.
 * Assembles LLM context, calls Type 2, validates response against drive state.
 */
export interface IResponseGeneratorService {
  /**
   * Generate a response to the given input.
   * Flow:
   * 1. Assemble LLM context: drive state, WKG knowledge, person model, conversation history
   * 2. Call LLM (Type 2 deliberation)
   * 3. Validate response against current drive state (TheaterValidator)
   * 4. Emit communication event (with cost) to EventsModule
   * 5. Return response
   *
   * @param input The parsed user input
   * @returns CommunicationResponse with drive snapshot and confidence
   * @throws CommunicationException if LLM call fails or theater validation fails
   * @throws DriveIsolationViolationError if attempting to access private drive evaluation
   */
  generateResponse(input: ParsedInput): Promise<CommunicationResponse>;

  /**
   * Generate a response synchronously from an existing Type 1 reflex.
   * Does not call the LLM. Only valid if the response has confidence > threshold.
   * Used for fast, low-cost responses that don't require deliberation.
   */
  generateReflexiveResponse(input: ParsedInput): Promise<CommunicationResponse | null>;
}

/**
 * LLM service interface.
 * Calls Anthropic Claude API for Type 2 deliberation.
 * Reports cost to EventsModule.
 */
export interface ILlmService {
  /**
   * Call Claude API with assembled context.
   * Measures latency and token count, reports to EventsModule.
   * @param context The full context blob: drive state, knowledge, memory, person model
   * @param personaInstructions Optional persona/style guidelines
   * @returns Generated text response from LLM
   * @throws LlmException if API call fails, timeout, or invalid response
   */
  complete(context: string, personaInstructions?: string): Promise<string>;
}

/**
 * Theater validation service interface.
 * Ensures response emotional valence correlates with actual drive state.
 * Per Immutable Standard 1 (Theater Prohibition).
 */
export interface ITheaterValidatorService {
  /**
   * Check if a response correlates with the given drive state.
   * Analyzes response sentiment/emotional markers and compares against drives.
   * Example: If response is happy but Satisfaction < 0.2, flag as theater.
   *
   * @param response Generated response text
   * @param driveState Current drive state at generation time
   * @returns { valid: boolean, issues: string[] } where issues are violations found
   */
  validateResponseCorrelation(response: string, driveState: DriveVector): { valid: boolean; issues: string[] };
}

/**
 * Person modeling service interface.
 * Manages per-person Other KGs and person profile inference.
 */
export interface IPersonModelingService {
  /**
   * Get or create a person model (Other KG) for the given person.
   * @param personId e.g., "Person_Jim"
   * @returns The person's knowledge graph model
   */
  getOrCreatePersonModel(personId: string): Promise<IOtherKg>;

  /**
   * Learn about a person from interaction.
   * Extracts preferences, knowledge about them, relationship dynamics.
   * Stores in their Other KG.
   * @param personId The person
   * @param interaction The conversation/observation to learn from
   * @throws PersonModelingException on KG write errors
   */
  learnFromInteraction(personId: string, interaction: CommunicationResponse): Promise<void>;

  /**
   * Get current model of a person's state/intent.
   * @returns Person profile: known preferences, inferred emotional state, conversation history
   */
  getCurrentPersonModel(personId: string): Promise<PersonProfile>;
}

/**
 * Voice gateway service interface.
 * Manages speech-to-text and text-to-speech with graceful fallback.
 */
export interface IVoiceGatewayService {
  /**
   * Convert audio stream to text via OpenAI Whisper.
   * Falls back to text-only mode if STT service is unavailable.
   * @throws VoiceException if both voice and fallback fail
   */
  speechToText(audioStream: ReadableStream<Buffer>): Promise<string>;

  /**
   * Convert text to audio stream via OpenAI TTS.
   * Synthesizes sentence-level to allow streaming and interruption.
   * Falls back to silent mode if TTS is unavailable.
   * @returns Observable<Buffer> emitting audio chunks
   */
  textToSpeech(text: string): Observable<Buffer>;

  /**
   * Check if voice services are operational.
   * Used by dashboard to show voice status and offer fallback UI.
   */
  getVoiceStatus(): Promise<{ sttAvailable: boolean; ttsAvailable: boolean }>;
}

/**
 * Chatbox service interface.
 * Sends text messages to UI via WebSocket or HTTP polling.
 */
export interface IChatboxService {
  /**
   * Send a message to the dashboard chatbox.
   * Broadcasts to all connected WebSocket clients for this conversation.
   * Falls back to HTTP polling route if WebSocket unavailable.
   * @param response The communication response to display
   */
  sendMessage(response: CommunicationResponse): Promise<void>;

  /**
   * Subscribe to incoming chatbox messages from the dashboard.
   * @returns Observable<string> emitting raw text messages
   */
  incomingMessages(): Observable<string>;
}

/**
 * Public Communication subsystem facade.
 * Other subsystems import and use this to orchestrate input/output.
 */
export interface ICommunicationService {
  /**
   * Process user input (text or voice) and generate a response.
   * Orchestrates: parsing -> person modeling -> response generation -> output delivery.
   *
   * @param rawInput Text or voice bytes from the user
   * @param inputType 'TEXT' | 'VOICE'
   * @param personId The person providing input (e.g., "Person_Jim")
   * @param conversationId Session ID for conversation continuity
   * @returns The generated response (text/audio/both as applicable)
   * @throws CommunicationException on parse or generation failure
   */
  processInput(
    rawInput: string | Buffer,
    inputType: 'TEXT' | 'VOICE',
    personId: string,
    conversationId: string,
  ): Promise<CommunicationResponse>;

  /**
   * Initiate a new conversation session.
   * Creates conversation record in TimescaleDB, initializes person model context.
   */
  startConversation(personId: string): Promise<string>; // Returns conversationId

  /**
   * End an active conversation.
   * Closes conversation record, consolidates learning (triggers Learning subsystem if enabled).
   */
  endConversation(conversationId: string): Promise<void>;
}
```

### 2.2 Person Modeling Interfaces

```typescript
// src/communication/person-modeling/person-modeling.interfaces.ts

/**
 * Person profile: inferred state and knowledge about a specific person.
 * Extracted from their Other KG and recent interaction.
 */
export interface PersonProfile {
  readonly personId: string;
  readonly knownPreferences: string[]; // "likes music", "prefers short answers"
  readonly knownAboutWorld: Record<string, unknown>; // What we know they know
  readonly recentEmotionalState: {
    readonly engagement: number; // 0.0-1.0: how engaged are they?
    readonly frustration: number;
    readonly satisfaction: number;
  };
  readonly conversationHistory: Array<{
    readonly timestamp: Date;
    readonly input: string;
    readonly response: string;
  }>; // Last 5-10 exchanges
  readonly lastInteractionTime: Date;
  readonly totalInteractions: number;
}

/**
 * Other KG interface (per-person knowledge graph).
 * Isolated from WKG; stores person-specific knowledge and preferences.
 */
export interface IOtherKg {
  /**
   * Upsert a node in this person's KG.
   * E.g., "Jim_Preference" nodes, "Jim_Knows_X" nodes.
   */
  upsertNode(label: string, type: string, properties: Record<string, unknown>): Promise<void>;

  /**
   * Query this person's KG.
   * E.g., "What does Jim know about coffee?"
   */
  query(cypher: string, params?: Record<string, unknown>): Promise<unknown[]>;
}
```

### 2.3 LLM Context Interfaces

```typescript
// src/communication/response-generator/response-generator.interfaces.ts

/**
 * Full context blob passed to the LLM for Type 2 deliberation.
 * Includes: drive state, WKG context, person model, conversation history.
 * This is the "what the LLM sees" about Sylphie's current state.
 */
export interface Type2Context {
  readonly driveState: DriveVector; // Current emotional/motivational state
  readonly recentMemory: string; // Last N events from TimescaleDB (episodic summary)
  readonly knowledgeContext: string; // Relevant WKG nodes for this conversation
  readonly personModel: PersonProfile; // What we know about the person
  readonly conversationHistory: string; // Recent exchanges in this session
  readonly systemInstructions: string; // Persona guidelines, behavioral constraints
  readonly confidenceThreshold: number; // Dynamic threshold for action selection
}

/**
 * Service that assembles the Type 2 context.
 * Queries WKG, EventsModule, person KG, and drive state.
 */
export interface ILlmContextAssemblerService {
  /**
   * Assemble full context for LLM deliberation.
   * @param input The parsed user input
   * @param personId Person ID
   * @param conversationId Conversation ID
   * @returns Type2Context ready for LLM
   */
  assembleContext(input: ParsedInput, personId: string, conversationId: string): Promise<Type2Context>;
}
```

### 2.4 Injection Tokens

```typescript
// src/communication/interfaces/communication.tokens.ts

/**
 * NestJS DI injection tokens for Communication subsystem.
 * Modules import these to inject services by interface, not concrete class.
 */

export const COMMUNICATION_SERVICE = Symbol('COMMUNICATION_SERVICE');
export const INPUT_PARSER_SERVICE = Symbol('INPUT_PARSER_SERVICE');
export const RESPONSE_GENERATOR_SERVICE = Symbol('RESPONSE_GENERATOR_SERVICE');
export const LLM_SERVICE = Symbol('LLM_SERVICE');
export const THEATER_VALIDATOR_SERVICE = Symbol('THEATER_VALIDATOR_SERVICE');
export const PERSON_MODELING_SERVICE = Symbol('PERSON_MODELING_SERVICE');
export const VOICE_GATEWAY_SERVICE = Symbol('VOICE_GATEWAY_SERVICE');
export const CHATBOX_SERVICE = Symbol('CHATBOX_SERVICE');
export const LLM_CONTEXT_ASSEMBLER_SERVICE = Symbol('LLM_CONTEXT_ASSEMBLER_SERVICE');
```

---

## 3. Dependency Injection Patterns

### 3.1 Constructor Injection in CommunicationService

```typescript
// src/communication/communication.service.ts
import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  COMMUNICATION_SERVICE,
  INPUT_PARSER_SERVICE,
  RESPONSE_GENERATOR_SERVICE,
  PERSON_MODELING_SERVICE,
  VOICE_GATEWAY_SERVICE,
  CHATBOX_SERVICE,
} from './interfaces/communication.tokens';
import {
  IInputParserService,
  IResponseGeneratorService,
  IPersonModelingService,
  IVoiceGatewayService,
  IChatboxService,
  ICommunicationService,
  ParsedInput,
  CommunicationResponse,
} from './interfaces/communication.interfaces';
import { EVENTS_SERVICE } from '../events/interfaces/events.tokens';
import { IEventsService } from '../events/interfaces/events.interfaces';
import { DRIVE_STATE_READER } from '../drive-engine/interfaces/drive-engine.tokens';
import { IDriveStateReader } from '../drive-engine/interfaces/drive-engine.interfaces';

@Injectable()
export class CommunicationService implements ICommunicationService {
  private readonly logger = new Logger(CommunicationService.name);

  constructor(
    @Inject(INPUT_PARSER_SERVICE)
    private readonly inputParser: IInputParserService,

    @Inject(RESPONSE_GENERATOR_SERVICE)
    private readonly responseGenerator: IResponseGeneratorService,

    @Inject(PERSON_MODELING_SERVICE)
    private readonly personModeling: IPersonModelingService,

    @Inject(VOICE_GATEWAY_SERVICE)
    private readonly voiceGateway: IVoiceGatewayService,

    @Inject(CHATBOX_SERVICE)
    private readonly chatbox: IChatboxService,

    @Inject(EVENTS_SERVICE)
    private readonly events: IEventsService,

    @Inject(DRIVE_STATE_READER)
    private readonly driveState: IDriveStateReader,

    private readonly config: ConfigService<AppConfig>,
  ) {}

  async processInput(
    rawInput: string | Buffer,
    inputType: 'TEXT' | 'VOICE',
    personId: string,
    conversationId: string,
  ): Promise<CommunicationResponse> {
    // Implementation uses injected services
  }
}
```

### 3.2 Drive State Read-Only Access

```typescript
// In any service that needs to read (but not write) drive state:

@Injectable()
export class ResponseGeneratorService {
  constructor(
    @Inject(DRIVE_STATE_READER)
    private readonly driveState: IDriveStateReader,
  ) {}

  async generateResponse(input: ParsedInput): Promise<CommunicationResponse> {
    // Read current drive state (this is allowed -- read-only)
    const currentDriveState = this.driveState.getCurrentState();

    // Call LLM with context that includes drive state
    // ...

    // Validate response against drive state
    // ...

    // Never write to drive state. That is a CANON violation.
  }
}
```

The `IDriveStateReader` interface exposes ONLY:
- `getCurrentState()` -- read current drive vector
- `driveState$` -- subscribe to state changes

There is no `updateDriveState()` or `modifyDrive()`. Write access is restricted to DriveEngineModule.

### 3.3 Knowledge Module Dependencies

```typescript
// src/communication/response-generator/llm-context-assembler.service.ts

@Injectable()
export class LlmContextAssemblerService implements ILlmContextAssemblerService {
  constructor(
    @Inject(WKG_SERVICE)
    private readonly wkg: IWkgService,

    @Inject(OTHER_KG_SERVICE)
    private readonly otherKg: IOtherKgService,

    @Inject(EVENTS_SERVICE)
    private readonly events: IEventsService,

    @Inject(PERSON_MODELING_SERVICE)
    private readonly personModeling: IPersonModelingService,
  ) {}

  async assembleContext(
    input: ParsedInput,
    personId: string,
    conversationId: string,
  ): Promise<Type2Context> {
    // Query WKG for context
    const wkgContext = await this.wkg.query(/* ... */);

    // Query person's Other KG
    const personModel = await this.personModeling.getCurrentPersonModel(personId);

    // Fetch conversation history from Events
    const history = await this.events.queryConversationHistory(conversationId, { limit: 10 });

    // Assemble into Type2Context
    return {
      driveState: this.driveState.getCurrentState(),
      recentMemory: this.summarizeMemory(wkgContext),
      knowledgeContext: this.formatWkgContext(wkgContext),
      personModel,
      conversationHistory: this.formatHistory(history),
      systemInstructions: this.buildSystemInstructions(),
      confidenceThreshold: this.computeDynamicThreshold(),
    };
  }
}
```

---

## 4. Configuration Schema

### 4.1 Communication-Specific Config

```typescript
// src/shared/config/communication.config.ts
import { IsString, IsNumber, IsBoolean, IsOptional, Min, Max, IsUrl } from 'class-validator';

/**
 * OpenAI API configuration for STT (Whisper) and TTS.
 */
export class OpenaiVoiceConfig {
  @IsString()
  @IsOptional()
  apiKey?: string; // If omitted, voice services disabled

  @IsString()
  @IsOptional()
  model?: string = 'gpt-4-turbo'; // For audio processing if needed

  /** Timeout for voice requests in milliseconds. */
  @IsNumber()
  @Min(1000)
  @Max(60000)
  timeoutMs: number = 30000;

  /** Sentence-level TTS synthesis (break long responses into sentences). */
  @IsBoolean()
  useSentenceLevelTts: boolean = true;
}

/**
 * Anthropic API configuration for LLM (Claude).
 * Note: Most LLM config is in AppConfig.llm.
 * Communication-specific overrides here.
 */
export class CommunicationLlmConfig {
  /** Max tokens for conversation responses (lower than deliberation budget). */
  @IsNumber()
  @Min(100)
  @Max(8192)
  maxTokensPerResponse: number = 1024;

  /** System instruction template for persona. */
  @IsString()
  @IsOptional()
  personaTemplate?: string; // Loaded from file or inline

  /** Enable context compression for long conversations. */
  @IsBoolean()
  enableContextCompression: boolean = true;
}

/**
 * Theater validation configuration.
 */
export class TheaterConfig {
  /** Enable theater validation (can be disabled for testing). */
  @IsBoolean()
  enabled: boolean = true;

  /** Threshold for drive-response correlation. 0.5 = moderate strictness. */
  @IsNumber()
  @Min(0.0)
  @Max(1.0)
  correlationThreshold: number = 0.6;

  /** Log theater violations as warnings (for debugging). */
  @IsBoolean()
  logViolations: boolean = true;
}

/**
 * Person modeling configuration.
 */
export class PersonModelingConfig {
  /** Enable per-person knowledge graph updates. */
  @IsBoolean()
  enabled: boolean = true;

  /** Max person profiles to maintain in memory. */
  @IsNumber()
  @Min(1)
  @Max(1000)
  maxProfiles: number = 100;

  /** Decay old interaction records after days. */
  @IsNumber()
  @Min(1)
  @Max(365)
  interactionRetentionDays: number = 90;
}

/**
 * Communication subsystem configuration (appended to AppConfig).
 */
export class CommunicationConfig {
  openai: OpenaiVoiceConfig;
  llm: CommunicationLlmConfig;
  theater: TheaterConfig;
  personModeling: PersonModelingConfig;
}
```

### 4.2 AppConfig Extension

```typescript
// src/shared/config/app.config.ts (updated)

export class AppConfig {
  @IsBoolean()
  debug: boolean = false;

  neo4j: Neo4jConfig;
  timescale: TimescaleConfig;
  postgres: PostgresConfig;
  llm: LlmConfig;
  communication: CommunicationConfig; // NEW
}
```

### 4.3 Environment Variables

```bash
# .env.example

# Communication config
OPENAI_API_KEY=sk-...
OPENAI_VOICE_TIMEOUT_MS=30000
COMMUNICATION_LLM_MAX_TOKENS_PER_RESPONSE=1024
COMMUNICATION_THEATER_ENABLED=true
COMMUNICATION_THEATER_CORRELATION_THRESHOLD=0.6
COMMUNICATION_PERSON_MODELING_ENABLED=true
COMMUNICATION_PERSON_MODELING_MAX_PROFILES=100
```

---

## 5. Error Handling & Exception Hierarchy

### 5.1 Communication Exception Hierarchy

```typescript
// src/communication/exceptions/communication.exceptions.ts

import { SylphieException } from '../../shared/exceptions/sylphie.exception';

/**
 * Base exception for Communication subsystem errors.
 */
export class CommunicationException extends SylphieException {
  // Inherits: message, context, name
}

/**
 * Input parsing failed.
 */
export class InputParsingException extends CommunicationException {
  constructor(
    reason: string,
    public readonly rawInput: string | Buffer,
    context?: Record<string, unknown>,
  ) {
    super(`Input parsing failed: ${reason}`, {
      ...context,
      inputLength: typeof rawInput === 'string' ? rawInput.length : rawInput.byteLength,
    });
  }
}

/**
 * LLM API call failed or returned invalid response.
 */
export class LlmException extends CommunicationException {
  constructor(
    reason: string,
    public readonly tokensCost?: number,
    public readonly latencyMs?: number,
  ) {
    super(`LLM call failed: ${reason}`, { tokensCost, latencyMs });
  }
}

/**
 * Theater validation failed: response doesn't correlate with drive state.
 */
export class TheaterViolationException extends CommunicationException {
  constructor(
    public readonly responseText: string,
    public readonly driveState: DriveVector,
    public readonly violations: string[],
  ) {
    super(`Theater violation detected`, {
      responseLength: responseText.length,
      violations,
      driveStateSnapshot: driveState,
    });
  }
}

/**
 * Voice service (STT/TTS) failed.
 */
export class VoiceException extends CommunicationException {
  constructor(
    service: 'STT' | 'TTS',
    reason: string,
    context?: Record<string, unknown>,
  ) {
    super(`${service} service failed: ${reason}`, context);
  }
}

/**
 * Person modeling failed (KG write, profile extraction, etc.).
 */
export class PersonModelingException extends CommunicationException {
  constructor(
    personId: string,
    operation: string,
    reason: string,
  ) {
    super(`Person modeling failed: ${operation} for ${personId}`, {
      personId,
      operation,
      reason,
    });
  }
}

/**
 * Attempted to violate drive isolation (e.g., write to drive state from Communication).
 */
export class DriveIsolationViolationException extends CommunicationException {
  constructor(attemptedOperation: string) {
    super(
      `CRITICAL: Drive isolation violation in Communication subsystem: ${attemptedOperation}`,
      { attemptedOperation },
    );
  }
}
```

### 5.2 Exception Filter & Propagation

```typescript
// src/communication/communication.service.ts

async processInput(
  rawInput: string | Buffer,
  inputType: 'TEXT' | 'VOICE',
  personId: string,
  conversationId: string,
): Promise<CommunicationResponse> {
  let parsedInput: ParsedInput;

  try {
    // Parse input
    if (inputType === 'VOICE') {
      parsedInput = await this.inputParser.parseVoiceInput(
        rawInput as Buffer,
        personId,
        conversationId,
      );
    } else {
      parsedInput = await this.inputParser.parseTextInput(
        rawInput as string,
        personId,
        conversationId,
      );
    }
  } catch (error) {
    if (error instanceof InputParsingException) {
      this.logger.warn(`Input parsing failed`, error.context);
      throw error; // Re-throw as-is; it's already typed
    }
    throw new InputParsingException(
      error instanceof Error ? error.message : 'Unknown error',
      rawInput,
    );
  }

  let response: CommunicationResponse;
  try {
    response = await this.responseGenerator.generateResponse(parsedInput);
  } catch (error) {
    if (error instanceof TheaterViolationException) {
      this.logger.warn(
        `Theater violation in response generation`,
        error.context,
      );
      // Optionally: fallback to reflexive response or generic safe response
      throw error;
    }
    if (error instanceof LlmException) {
      this.logger.error(`LLM call failed`, error.context);
      throw error;
    }
    throw new CommunicationException(`Response generation failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    // Emit event
    await this.events.emit({
      type: 'COMMUNICATION_OUTPUT',
      personId,
      conversationId,
      response,
      timestamp: new Date(),
    });

    // Deliver output
    await this.chatbox.sendMessage(response);

    if (response.shouldSpeakAloud) {
      await this.voiceGateway.textToSpeech(response.text).toPromise();
    }
  } catch (error) {
    this.logger.error(`Output delivery failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    // Graceful degradation: attempt text fallback, but don't crash the subsystem
  }

  return response;
}
```

---

## 6. Async Patterns & Streaming

### 6.1 Sentence-Level TTS Streaming

```typescript
// src/communication/voice/tts.service.ts
import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import OpenAI from 'openai';

@Injectable()
export class TtsService {
  private readonly openai: OpenAI;

  constructor(
    private readonly config: ConfigService<AppConfig>,
  ) {
    const openaiKey = this.config.get('communication.openai.apiKey');
    if (!openaiKey) {
      throw new Error('OpenAI API key not configured for TTS');
    }
    this.openai = new OpenAI({ apiKey: openaiKey });
  }

  /**
   * Convert text to speech, streaming at sentence level.
   * Returns Observable<Buffer> that emits audio chunks for each sentence.
   * Allows dashboard to play audio progressively and enable interruption.
   */
  textToSpeech(text: string): Observable<Buffer> {
    return new Observable<Buffer>(async (observer) => {
      try {
        const sentences = this.splitIntoSentences(text);

        for (const sentence of sentences) {
          try {
            const audioBuffer = await this.synthesizeSentence(sentence);
            observer.next(audioBuffer);
          } catch (error) {
            observer.error(
              new VoiceException('TTS', `Failed to synthesize sentence: ${sentence}`, {
                error: error instanceof Error ? error.message : String(error),
              }),
            );
            return;
          }
        }

        observer.complete();
      } catch (error) {
        observer.error(
          new VoiceException('TTS', 'Text-to-speech failed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });
  }

  private async synthesizeSentence(sentence: string): Promise<Buffer> {
    const mp3 = await this.openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: sentence,
    });
    return Buffer.from(await mp3.arrayBuffer());
  }

  private splitIntoSentences(text: string): string[] {
    // Simple regex-based sentence splitting
    return text.split(/[.!?]+/).filter((s) => s.trim());
  }
}
```

### 6.2 WebSocket Voice Stream Gateway

```typescript
// src/communication/voice/voice-gateway.service.ts

@Injectable()
export class VoiceGatewayService implements IVoiceGatewayService {
  private sttAvailable = true;
  private ttsAvailable = true;

  constructor(
    private readonly stt: SttService,
    private readonly tts: TtsService,
    @Inject(CHATBOX_SERVICE) private readonly chatbox: IChatboxService,
    private readonly logger: Logger,
  ) {
    this.healthCheck();
  }

  async speechToText(audioStream: ReadableStream<Buffer>): Promise<string> {
    if (!this.sttAvailable) {
      throw new VoiceException(
        'STT',
        'Speech-to-text service unavailable; use text input instead',
      );
    }

    try {
      const audioBuffer = await this.streamToBuffer(audioStream);
      const text = await this.stt.transcribe(audioBuffer);
      return text;
    } catch (error) {
      this.sttAvailable = false;
      this.logger.error('STT service failed; marking unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new VoiceException('STT', 'Transcription failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  textToSpeech(text: string): Observable<Buffer> {
    return new Observable<Buffer>((observer) => {
      if (!this.ttsAvailable) {
        observer.error(
          new VoiceException('TTS', 'Text-to-speech service unavailable'),
        );
        return;
      }

      this.tts.textToSpeech(text).subscribe({
        next: (chunk) => observer.next(chunk),
        error: (error) => {
          this.ttsAvailable = false;
          this.logger.error('TTS service failed; marking unavailable', { error });
          observer.error(error);
        },
        complete: () => observer.complete(),
      });
    });
  }

  async getVoiceStatus(): Promise<{ sttAvailable: boolean; ttsAvailable: boolean }> {
    return {
      sttAvailable: this.sttAvailable,
      ttsAvailable: this.ttsAvailable,
    };
  }

  private async healthCheck(): Promise<void> {
    // Periodic health check; mark services unavailable if they fail
    setInterval(async () => {
      try {
        // Lightweight ping to OpenAI to verify API availability
        // If fails, set sttAvailable/ttsAvailable = false
      } catch {
        this.sttAvailable = false;
        this.ttsAvailable = false;
      }
    }, 60000); // Every minute
  }

  private streamToBuffer(stream: ReadableStream<Buffer>): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const reader = stream.getReader();

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          resolve(Buffer.concat(chunks));
        } catch (error) {
          reject(error);
        }
      })();
    });
  }
}
```

### 6.3 Async Module Initialization

```typescript
// src/communication/communication.module.ts (enhanced)

@Module({
  // ...
  providers: [
    // Async initialization for external services
    {
      provide: 'OPENAI_CLIENT',
      useFactory: (config: ConfigService<AppConfig>) => {
        const apiKey = config.get('communication.openai.apiKey');
        if (!apiKey) {
          throw new Error('OpenAI API key not configured');
        }
        return new OpenAI({ apiKey });
      },
      inject: [ConfigService],
    },
    // ... other providers
  ],
})
export class CommunicationModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommunicationModule.name);

  async onModuleInit(): Promise<void> {
    // Verify external service connectivity
    const voiceStatus = await this.voiceGateway.getVoiceStatus();
    this.logger.log(`Voice services initialized: STT=${voiceStatus.sttAvailable}, TTS=${voiceStatus.ttsAvailable}`);
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Communication module shutting down');
    // Clean up WebSocket connections, pending voice streams, etc.
  }
}
```

---

## 7. Module Boundaries & Exports

### 7.1 What CommunicationModule Exports

```typescript
// src/communication/index.ts
export {
  COMMUNICATION_SERVICE,
  INPUT_PARSER_SERVICE,
  RESPONSE_GENERATOR_SERVICE,
  PERSON_MODELING_SERVICE,
  VOICE_GATEWAY_SERVICE,
  CHATBOX_SERVICE,
} from './interfaces/communication.tokens';

export type {
  ICommunicationService,
  IInputParserService,
  IResponseGeneratorService,
  IPersonModelingService,
  IVoiceGatewayService,
  IChatboxService,
  ParsedInput,
  CommunicationResponse,
  PersonProfile,
} from './interfaces/communication.interfaces';

export {
  CommunicationException,
  InputParsingException,
  LlmException,
  TheaterViolationException,
  VoiceException,
  PersonModelingException,
} from './exceptions/communication.exceptions';
```

### 7.2 What DecisionMakingModule Sees

```typescript
// In src/decision-making/decision-making.module.ts

import { Module } from '@nestjs/common';
import { CommunicationModule } from '../communication/communication.module';
import { COMMUNICATION_SERVICE } from '../communication/interfaces/communication.tokens';
import { ICommunicationService } from '../communication/interfaces/communication.interfaces';

@Module({
  imports: [CommunicationModule],
  // ...
})
export class DecisionMakingModule {}

// In a service within DecisionMaking:
@Injectable()
export class DecisionMakingService {
  constructor(
    @Inject(COMMUNICATION_SERVICE)
    private readonly communication: ICommunicationService,
  ) {}

  async executeAction(action: Action): Promise<void> {
    if (action.type === 'COMMUNICATE') {
      await this.communication.processInput(
        action.payload.input,
        'TEXT',
        action.personId,
        action.conversationId,
      );
    }
  }
}
```

DecisionMakingService:
- Can inject `COMMUNICATION_SERVICE` (the public facade)
- Cannot access internal services (`InputParserService`, `LlmService`, etc.)
- Cannot access private details like person model updates

### 7.3 Preventing Anti-Patterns

**Anti-pattern 1: Bypassing CommunicationService**

```typescript
// BAD: importing internal service directly
import { LlmService } from '../communication/llm/llm.service';

@Injectable()
export class DecisionMakingService {
  constructor(private readonly llm: LlmService) {} // WRONG
}
```

**Why bad:** Violates module boundary. DecisionMaking should not know LLM exists.

**Correct pattern:**

```typescript
// GOOD: importing only the public facade
import { COMMUNICATION_SERVICE } from '../communication/interfaces/communication.tokens';
import { ICommunicationService } from '../communication/interfaces/communication.interfaces';

@Injectable()
export class DecisionMakingService {
  constructor(
    @Inject(COMMUNICATION_SERVICE)
    private readonly communication: ICommunicationService,
  ) {}
}
```

**Anti-pattern 2: Person model leaking into WKG**

```typescript
// BAD: storing person-specific knowledge in the WKG
async learnFromInteraction(personId: string, input: string): Promise<void> {
  // Creates nodes like "Jim_likes_coffee" in the WKG
  // This is contamination; should go in Jim's Other KG instead
  await this.wkg.upsertNode('Jim_likes_coffee', 'Preference', { /* ... */ });
}
```

**Correct pattern:**

```typescript
async learnFromInteraction(personId: string, input: string): Promise<void> {
  // Creates nodes in Jim's Other KG (isolated from WKG)
  const personKg = await this.personModeling.getOrCreatePersonModel(personId);
  await personKg.upsertNode('Preference_Coffee', 'Preference', { /* ... */ });
}
```

**Anti-pattern 3: LLM calls without cost reporting**

```typescript
// BAD: LLM call without emitting cost event
async generateResponse(input: ParsedInput): Promise<string> {
  const startMs = Date.now();
  const response = await this.llm.complete(context);
  // Missing: event emission to EventsModule
  return response;
}
```

**Correct pattern:**

```typescript
async generateResponse(input: ParsedInput): Promise<string> {
  const startMs = Date.now();
  const response = await this.llm.complete(context);
  const latencyMs = Date.now() - startMs;

  // REQUIRED: Report cost to drive engine
  await this.events.emit({
    type: 'TYPE_2_DELIBERATION_COST',
    latencyMs,
    cognitiveEffortEstimate: this.estimateCognitiveEffort(latencyMs),
    timestamp: new Date(),
  });

  return response;
}
```

---

## 8. Anti-Patterns to Prevent

### 8.1 LLM as Decision-Maker

**Pattern:** Communication service directly calls LLM to decide actions.

**Why it's wrong:** The LLM should only translate; action selection belongs to DecisionMaking subsystem.

**Prevention:** CommunicationService accepts input and generates **response text only**. It does not decide what Sylphie should do. DecisionMakingService owns the action selection loop.

### 8.2 Theater Without Validation

**Pattern:** Generate responses without checking if they correlate with drive state.

**Why it's wrong:** Violates Immutable Standard 1 (Theater Prohibition). System learns to perform emotions it doesn't have.

**Prevention:** ResponseGeneratorService always calls TheaterValidator before returning response. If validation fails, response is rejected (or fallback to reflexive response).

### 8.3 Person Model Contamination

**Pattern:** Person-specific knowledge mixed into the WKG.

**Why it's wrong:** WKG should contain world knowledge (facts about the world), not opinion/preference about individuals. Over time, Person KG isolation breaks and contamination spreads.

**Prevention:**
- All person-specific learning goes to per-person Other KGs
- PersonModelingService strictly enforces this boundary
- WKG nodes are world facts, not "Jim thinks X"

### 8.4 Provenance Laundering

**Pattern:** LLM-generated knowledge gets persisted without `LLM_GENERATED` provenance tag.

**Why it's wrong:** Breaks confidence ceiling mechanism. LLM_GENERATED nodes should never exceed 0.35 confidence without successful use. If provenance is stripped, confidence ceiling is invisible.

**Prevention:** Every node written to WKG/KGs carries explicit provenance. LlmContextAssemblerService never upgrades LLM_GENERATED to higher provenance.

### 8.5 Unmetered LLM Calls

**Pattern:** Multiple LLM calls in ResponseGeneratorService without tracking total cost.

**Why it's wrong:** Type 2 cost is what creates evolutionary pressure toward Type 1 graduation. Unmetered calls hide the cost, preventing development.

**Prevention:**
- Single LLM call per response (efficiency)
- All LLM calls report cost to EventsModule
- Cost includes tokens + latency + concurrent requests
- Drive Engine uses this cost data to adjust Type 1/Type 2 threshold

### 8.6 Synchronous Voice Operations

**Pattern:** Await TTS/STT in the request-response cycle without timeout or cancellation.

**Why it's wrong:** Long voice synthesis times block the main loop. User can't interrupt. Slow TTS response = low responsiveness.

**Prevention:**
- Voice operations use Observables, allowing async streaming
- Timeouts enforced at the gateway level
- Dashboard can interrupt playback and re-request text-only response

### 8.7 Global Voice Status

**Pattern:** Voice subsystem state is global, single point of failure.

**Why it's wrong:** If TTS fails once, entire system degrades. No recovery path.

**Prevention:**
- Graceful degradation: voice services are optional
- Text fallback always available
- Voice services can be re-enabled on next call
- Health check runs periodically; status flag updates independently

---

## 9. Key Technical Decisions

### 9.1 Why Separate Input Parser & Response Generator?

**Pattern:** Two distinct services instead of one "Conversational AI" service.

**Rationale:**
- Input parsing is mostly deterministic (syntax, entity extraction)
- Response generation requires LLM + drive state + validation
- Separating them allows inputless operation (e.g., Decision Making generates actions without parsing user input)
- Easier to test and compose independently

### 9.2 Why Theater Validator as Separate Service?

**Pattern:** Validation logic extracted into dedicated service.

**Rationale:**
- Theater validation is a CANON constraint (Immutable Standard 1)
- Separates validation logic from response generation
- Can be unit-tested independently
- Can be toggled via configuration (for testing)

### 9.3 Why Observable-Based Voice Streaming?

**Pattern:** `textToSpeech()` returns `Observable<Buffer>` instead of `Promise<Buffer>`.

**Rationale:**
- Allows dashboard to stream audio progressively (low latency to first audio)
- Supports interruption: dashboard can unsubscribe mid-synthesis
- Sentence-level chunking is natural with Observables
- Composable with RxJS operators (throttle, debounce, timeout)

### 9.4 Why per-Person Other KGs?

**Pattern:** Grafeo KG per person, isolated from WKG.

**Rationale:**
- World knowledge (WKG) != opinions about individuals
- Separate storage enables different confidence/trust mechanics
- Can expire old person models (retention policy)
- Prevents conflation of facts with preferences

### 9.5 Why LLM Context Assembler as Service?

**Pattern:** Context assembly extracted into dedicated service.

**Rationale:**
- Context assembly is complex: WKG queries + drive state + person model + memory summarization
- Separates concerns: "what goes into the prompt" vs "what does the LLM do with it"
- Can be tested independently of LLM service
- Can be extended with new context types (e.g., recent planning outcomes)

---

## 10. Ticket Breakdown (10-15 Tickets)

### Ticket Structure

Each ticket is sized for 1-2 days of focused implementation. Pre-dependencies are noted. Tickets are sequenced to enable parallel work where possible.

---

### Ticket E6.1: Communication Interfaces & Tokens (No dependencies)

**Title:** Define Communication subsystem interfaces and DI tokens

**Description:**
- Create `src/communication/interfaces/communication.interfaces.ts` with all interfaces listed in Section 2
- Create `src/communication/interfaces/communication.tokens.ts` with DI injection tokens
- Create `src/communication/exceptions/communication.exceptions.ts` with exception hierarchy
- Ensure all interfaces have complete JSDoc with CANON-specific behavior notes

**Acceptance Criteria:**
- All interfaces export from `src/communication/index.ts`
- TypeScript strict compilation
- No `any` types
- Every public method has JSDoc with return type, throws, and CANON context

**Effort:** 1 day

---

### Ticket E6.2: Configuration Schema (Depends on: E6.1)

**Title:** Add Communication config to AppConfig and environment validation

**Description:**
- Create `src/shared/config/communication.config.ts` with OpenAI, LLM, Theater, PersonModeling config classes
- Update `src/shared/config/app.config.ts` to include `communication: CommunicationConfig`
- Add validation decorators (class-validator) for all config fields
- Create `.env.example` with Communication-specific variables

**Acceptance Criteria:**
- Config loads from environment with validation
- Missing required keys fail fast at app startup with clear error message
- All config fields have sensible defaults
- Config is immutable after validation

**Effort:** 1 day

---

### Ticket E6.3: Communication Module Structure (Depends on: E6.1, E6.2)

**Title:** Create Communication module skeleton with providers and imports

**Description:**
- Create `src/communication/communication.module.ts` with all providers listed in Section 1.2
- Create empty stub files for all sub-services (InputParserService, ResponseGeneratorService, etc.)
- Wire imports: KnowledgeModule, EventsModule, DriveEngineModule, ConfigModule
- Create `src/communication/index.ts` with barrel exports
- Ensure module compiles and imports correctly

**Acceptance Criteria:**
- NestJS module structure is valid (no circular dependencies)
- All providers are declared
- No unresolved imports
- Module can be imported by AppModule without errors

**Effort:** 1 day

---

### Ticket E6.4: InputParserService Implementation (Depends on: E6.3)

**Title:** Implement input parsing: text/voice to ParsedInput

**Description:**
- Implement `InputParserService.parseTextInput()`: parse text using lightweight entity extraction (regex or simple NLP)
- Implement `InputParserService.parseVoiceInput()`: delegate to SttService, then parseTextInput
- Extract intent using heuristics or simple LLM prompt (low-cost classifier)
- Query WKG for context (recent entities mentioned, conversation history)
- Return ParsedInput with confidence score

**Acceptance Criteria:**
- Text parsing identifies common intents (QUERY, STATEMENT, COMMAND, CORRECTION, etc.)
- Entity extraction retrieves at least simple noun phrases
- Confidence score reflects parsing quality (0.5-1.0)
- Throws InputParsingException with context on failure
- Handles edge cases: empty input, very long input, non-ASCII text

**Effort:** 2 days

---

### Ticket E6.5: InputParser Tests (Depends on: E6.4)

**Title:** Unit tests for InputParserService

**Description:**
- Test parseTextInput with sample queries, statements, commands
- Test intent extraction accuracy
- Test entity extraction (known entities, novel entities)
- Test error handling: malformed input, external service failures
- Mock WKG queries

**Acceptance Criteria:**
- >85% line coverage
- All intent types covered
- Error paths tested

**Effort:** 1 day

---

### Ticket E6.6: LLM Service Integration (Depends on: E6.3)

**Title:** Implement LlmService for Anthropic Claude API calls

**Description:**
- Implement `LlmService.complete()`: calls Anthropic Claude API
- Measure request latency and token usage
- Emit cost event to EventsModule (mandatory per CANON §Dual-Process)
- Handle API errors, timeouts, rate limits
- Log all LLM calls with context (for debugging)
- Implement retry logic for transient failures

**Acceptance Criteria:**
- Successful API calls return parsed response
- Cost event emitted every time (no exceptions)
- Timeouts respected (configurable)
- Errors wrapped in LlmException with context
- Latency logged (for later Type 2 cost analysis)

**Effort:** 2 days

---

### Ticket E6.7: LLM Context Assembler (Depends on: E6.3, E4 working)

**Title:** Implement LlmContextAssemblerService

**Description:**
- Implement `assembleContext()`: queries WKG, reads drive state, fetches conversation history, person model
- Format drive state for LLM (plain language summary of emotional state)
- Summarize recent WKG queries into conversational context
- Load system instructions/persona from config or file
- Compute dynamic confidence threshold based on current drive state

**Acceptance Criteria:**
- Context includes: drive state, recent memory, knowledge context, person model, conversation history
- Drive state formatted as plain English summary
- Persona instructions loaded from config
- WKG context is relevant to current conversation
- Total context fits within LLM token budget

**Effort:** 2 days

---

### Ticket E6.8: TheaterValidatorService (Depends on: E6.1)

**Title:** Implement theater validation logic

**Description:**
- Implement `validateResponseCorrelation()`: analyze response sentiment/emotional markers
- Map response emotional content to drive state
- Examples:
  - Response says "I'm so happy!" but Satisfaction < 0.2 → violation
  - Response says "I don't care" but Curiosity > 0.7 → violation
- Return violations list; all violations must pass configurable threshold to clear
- Handle edge cases: neutral responses, complex emotions

**Acceptance Criteria:**
- Detects obvious theater violations (happy response + low satisfaction)
- Allows valid mismatches (e.g., "I'm sad about this situation but here's a solution")
- Returns clear violation descriptions
- Configurable strictness threshold
- Can be disabled for testing

**Effort:** 2 days

---

### Ticket E6.9: ResponseGeneratorService (Depends on: E6.6, E6.7, E6.8)

**Title:** Implement response generation pipeline

**Description:**
- Implement `generateResponse()`:
  1. Assemble Type 2 context (via LlmContextAssemblerService)
  2. Call LLM (via LlmService)
  3. Validate response against drive state (via TheaterValidator)
  4. If theater validation fails, attempt reflexive fallback or raise exception
  5. Emit communication event to EventsModule
  6. Return CommunicationResponse with drive snapshot
- Implement `generateReflexiveResponse()` for Type 1 fast paths (if available)

**Acceptance Criteria:**
- Happy path: generates valid responses to typical inputs
- Theater validation enforced: invalid responses are rejected
- Cost reporting: all LLM calls have corresponding cost events
- Fallback logic: graceful degradation if LLM fails
- Conversation context preserved: responses reference earlier exchanges

**Effort:** 3 days

---

### Ticket E6.10: PersonModelingService (Depends on: E6.3, E3 working)

**Title:** Implement per-person Other KG management

**Description:**
- Implement `getOrCreatePersonModel()`: returns per-person Grafeo KG
- Implement `learnFromInteraction()`: extract preferences, knowledge, emotional state from interaction; store in Other KG
- Implement `getCurrentPersonModel()`: assemble PersonProfile from Other KG
- Track: known preferences, what person knows, recent emotional state, conversation history
- Implement retention policy: expire old interactions after configurable days

**Acceptance Criteria:**
- Person models are isolated from WKG
- Person profiles are extractable and usable by ResponseGeneratorService
- Preferences and opinions stay in Other KGs
- Conversation history is accessible and limited to recent exchanges
- Retention policy is enforced

**Effort:** 2 days

---

### Ticket E6.11: Voice Services (STT/TTS) (Depends on: E6.1)

**Title:** Implement STT and TTS services

**Description:**
- Implement `SttService.transcribe()`: calls OpenAI Whisper API on audio bytes, returns text
- Implement `TtsService.textToSpeech()`: calls OpenAI TTS, returns Observable<Buffer> emitting audio chunks per sentence
- Implement sentence splitting logic for streaming synthesis
- Error handling: wrap OpenAI errors in VoiceException
- Health checks: periodically verify service availability

**Acceptance Criteria:**
- STT converts speech to text accurately
- TTS synthesizes text to audio in sentence-level chunks
- Observable allows progressive streaming and interruption
- Errors are wrapped in domain exceptions
- Timeout enforced (from config)

**Effort:** 2 days

---

### Ticket E6.12: VoiceGatewayService (Depends on: E6.11)

**Title:** Implement voice gateway with graceful degradation

**Description:**
- Implement `speechToText()`: calls SttService, falls back to error if unavailable
- Implement `textToSpeech()`: calls TtsService, gracefully degrades if unavailable
- Implement `getVoiceStatus()`: returns availability flags
- Implement health check loop: periodically pings voice services
- Mark services unavailable if failures occur; allow re-enabling on next call

**Acceptance Criteria:**
- Voice calls degrade gracefully (text-only mode if voice unavailable)
- Health check runs periodically and updates service flags
- Dashboard can query voice status and adjust UI
- No crashes if voice service is down

**Effort:** 1 day

---

### Ticket E6.13: ChatboxService (Depends on: E6.1)

**Title:** Implement chatbox output via WebSocket and fallback

**Description:**
- Implement `sendMessage()`: broadcasts response to WebSocket clients for the conversation
- Implement fallback: if WebSocket unavailable, queue messages for HTTP polling
- Implement `incomingMessages()`: returns Observable<string> of incoming chatbox messages
- Handle connection lifecycle: connect, disconnect, reconnect

**Acceptance Criteria:**
- Messages are delivered to dashboard in real-time
- WebSocket disconnections don't cause message loss
- Fallback HTTP polling works
- Observable allows dashboard to stream incoming messages

**Effort:** 1 day

---

### Ticket E6.14: CommunicationService Facade (Depends on: E6.4, E6.9, E6.10, E6.12, E6.13)

**Title:** Implement CommunicationService public facade

**Description:**
- Implement `processInput()`: orchestrates input parsing, response generation, person modeling, output delivery
- Implement `startConversation()`: creates conversation record, initializes person model context
- Implement `endConversation()`: closes conversation, triggers learning if enabled
- Wire all sub-services together in the right order
- Handle errors and propagate/log appropriately

**Acceptance Criteria:**
- processInput works end-to-end: text → parse → generate → deliver
- Voice input triggers STT before parsing
- Person model is updated after every interaction
- Conversation lifecycle is tracked in EventsModule
- All errors are caught and wrapped in domain exceptions

**Effort:** 2 days

---

### Ticket E6.15: Integration Tests (Depends on: E6.14)

**Title:** End-to-end tests for Communication subsystem

**Description:**
- Test full conversation flow: text input → parse → generate → validate → output
- Test voice input flow: audio → STT → parse → generate → TTS → output
- Test voice degradation: TTS fails, fallback to text only
- Test person modeling: extract preferences, verify they persist
- Test theater validation: ensure theater violations are caught
- Test cost reporting: verify LLM cost events are emitted
- Mock KnowledgeModule, EventsModule, DriveEngineModule

**Acceptance Criteria:**
- >80% module coverage
- All happy paths tested
- Error paths tested (parsing failure, LLM failure, voice failure)
- Theater validation tested with sample violations
- Person modeling tested across multiple interactions

**Effort:** 2 days

---

## 11. Dependencies & Sequencing

### Critical Path

```
E6.1 (Interfaces) [Day 1]
  ↓
E6.2 (Config) [Day 2]
  ↓
E6.3 (Module Structure) [Day 3]
  ↓
E6.4 (InputParser) [Days 4-5]
  E6.6 (LLM Service) [Days 4-5] (parallel)
  E6.11 (Voice Services) [Days 4-5] (parallel)
  ↓
E6.7 (LLM Context Assembler) [Days 6-7]
  ↓
E6.8 (TheaterValidator) [Days 8-9]
  ↓
E6.9 (ResponseGenerator) [Days 10-12]
  E6.10 (PersonModeling) [Days 10-11] (can start after E6.3)
  ↓
E6.12 (VoiceGateway) [Day 13]
E6.13 (Chatbox) [Day 13] (parallel)
  ↓
E6.14 (CommunicationService Facade) [Days 14-15]
  ↓
E6.15 (Integration Tests) [Days 16-17]
```

**Total duration:** ~3 weeks (with 2-3 days of intensive work).

Parallel tracks:
- E6.4, E6.6, E6.11 can proceed in parallel (after E6.3)
- E6.10 can start early (only depends on E6.3 and working Knowledge/Events modules)

---

## 12. Anti-Patterns & Prevention Checklist

During code review, check:

- [ ] **LLM decision-making prevented:** ResponseGeneratorService only generates text; it does not choose actions. Action selection is DecisionMakingModule responsibility.
- [ ] **Theater validation enforced:** Every response is validated against drive state before returning. No exceptions (unless explicitly logged as test mode).
- [ ] **Person model isolation:** No person-specific knowledge in WKG. All person learning goes to Other KGs.
- [ ] **Provenance preserved:** Every WKG/KG write carries explicit provenance tag. LLM_GENERATED never upgrades without successful use.
- [ ] **Cost reporting mandatory:** Every LLM call emits cost event to EventsModule. No exceptions.
- [ ] **Voice graceful degradation:** Voice failures don't crash the system. Text fallback always available.
- [ ] **Drive isolation respected:** No code in Communication writes to DriveEngineModule evaluation function. Only reads drive state.
- [ ] **Module boundaries enforced:** Other modules can only inject COMMUNICATION_SERVICE and VOICE_GATEWAY_SERVICE. Internal services are not exported.
- [ ] **Configuration external:** No hardcoded API keys, timeouts, or behavioral parameters. All via ConfigService.
- [ ] **Error handling explicit:** All async operations have try-catch; errors wrapped in domain exceptions with context.

---

## 13. Known Unknowns & Assumptions

### Assumptions

1. **LLM context assembly is feasible within token budget.** If WKG gets very large, context summarization may become expensive. Monitor token usage.
2. **OpenAI voice services are reliable.** Falls back to text mode if not. If text-only becomes standard, reconsider architecture (eliminate TtsService dependency).
3. **Person models don't need cross-person inference.** Jim's Other KG only learns about Jim. If system needs to generalize (e.g., "most people like..."), that's a future enhancement.
4. **Theater validation heuristics are sufficient.** Simple sentiment + drive state correlation may miss subtle cases. May need feedback loop to improve.

### Known Unknowns

1. **What constitutes "sufficient" person modeling?** How much detail do we need about a person before interactions become personalized?
2. **How does voice interaction impact learning?** Does hearing Sylphie's voice change the learning dynamics? (Phase 2 question.)
3. **What's the optimal LLM context size?** Too small: missing context. Too large: expensive, confusing. Likely requires tuning.
4. **How does theater validation interact with drive dynamics?** If a response is rejected for theater violation, what happens? Fallback to reflexive? Return error? Needs testing.

---

## 14. Success Criteria

By end of Epic 6:

1. **Input/output loop is complete:** User can provide text input and receive text response. Voice optional (falls back to text).
2. **Theater validation works:** Response correlates with actual drive state. Violations are caught and logged.
3. **Person modeling works:** System learns about people across multiple interactions. Preferences persist.
4. **LLM cost is visible:** Every deliberation has a corresponding cost event in EventsModule.
5. **Module boundaries enforced:** Communication is a self-contained module. DecisionMaking does not import internals.
6. **Graceful degradation:** Voice service failure doesn't crash the system. Text fallback activates.
7. **Integration with E2, E3, E4 is solid:** Events are written/read correctly. WKG and Other KGs function correctly. Drive state is readable.

---

## 15. Gotchas for Next Agent

1. **Drive state is read-only.** Do not attempt to write to DriveEngineModule. If you need to change drive behavior, the change goes in Drive Engine's evaluation function, not here.
2. **LLM_GENERATED provenance is sacred.** Never strip or upgrade it without a successful use event. The confidence ceiling depends on it.
3. **Person models are isolated.** If you find yourself storing person data in WKG, stop. Use Other KGs instead.
4. **Voice streams are Observables.** Don't try to turn them into Promises; the whole point is streaming. Let the dashboard subscribe.
5. **Theater validation can be strict.** Some test cases may fail validation even though they're semantically reasonable. Tune the threshold or improve heuristics.
6. **Context assembly is expensive.** Profiling shows which queries are slow. Optimize queries and cache person profiles if needed.

---

## End of Analysis

**Prepared by:** Forge (NestJS/TypeScript Systems Architect)
**Date:** 2026-03-29
**Next Step:** Assign tickets E6.1–E6.15 to implementation agents.
