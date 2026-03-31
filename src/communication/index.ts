/**
 * Communication module public API — barrel re-export.
 *
 * Consumers import from 'src/communication' (or a relative equivalent)
 * rather than from internal file paths. This barrel is the contract boundary.
 * Internal implementation files are not part of the public API.
 *
 * Sections:
 *   1. Module        — CommunicationModule for AppModule wiring
 *   2. Tokens        — DI injection tokens (NOTE: LLM_SERVICE is in src/shared)
 *   3. Interfaces    — All Communication subsystem interface contracts and types
 */

// ---------------------------------------------------------------------------
// 1. Module
// ---------------------------------------------------------------------------

export { CommunicationModule } from './communication.module';

// ---------------------------------------------------------------------------
// 2. Tokens
// ---------------------------------------------------------------------------

export {
  COMMUNICATION_SERVICE,
  INPUT_PARSER_SERVICE,
  PERSON_MODELING_SERVICE,
  THEATER_VALIDATOR,
  STT_SERVICE,
  TTS_SERVICE,
  RESPONSE_GENERATOR,
  LLM_CONTEXT_ASSEMBLER,
  SOCIAL_CONTINGENCY,
  CHATBOX_GATEWAY,
} from './communication.tokens';

// LLM_SERVICE token is exported from src/shared/types/llm.types.ts.
// Re-exported here for convenience so callers can find it via the Communication
// barrel, but it lives in shared.
export { LLM_SERVICE } from '../shared/types/llm.types';

// ---------------------------------------------------------------------------
// 3. Interfaces and Types
// ---------------------------------------------------------------------------

export type {
  // Input
  GuardianInput,
  InputIntentType,
  ParsedEntity,
  ParsedInput,
  // Action
  ActionIntent,
  // Output
  GeneratedResponse,
  CommunicationResult,
  // Theater Prohibition
  TheaterViolation,
  TheaterValidationResult,
  // Person Modeling
  PersonModel,
  // STT / TTS
  TranscriptionResult,
  TtsOptions,
  SynthesisResult,
  // Communication Events
  InputReceivedEvent,
  InputParsedEvent,
  ResponseGeneratedEvent,
  ResponseDeliveredEvent,
  SocialCommentInitiatedEvent,
  // Response Generation
  ResponseGenerationContext,
  ConversationMessage,
  EpisodeSummary,
  ConversationThread,
  // Cost Tracking
  LlmCostReport,
  // Drive Narratives
  DriveNarrative,
  MotivationalNarrative,
  // Service interfaces
  ICommunicationService,
  IInputParserService,
  IPersonModelingService,
  ITheaterValidator,
  ISttService,
  ITtsService,
} from './interfaces/communication.interfaces';
