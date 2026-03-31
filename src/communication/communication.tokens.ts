/**
 * Dependency injection tokens for the Communication module.
 *
 * Symbol tokens prevent name collisions at DI registration. Consuming services
 * inject these via @Inject(TOKEN) rather than depending on concrete classes.
 *
 * LLM_SERVICE is intentionally absent from this file. It is defined in
 * src/shared/types/llm.types.ts so that Learning and Planning can inject the
 * LLM without taking a cross-subsystem dependency on CommunicationModule.
 * CommunicationModule provides the LLM_SERVICE token implementation; it does
 * not redefine the token.
 *
 * Usage:
 *   import { COMMUNICATION_SERVICE } from '../communication/communication.tokens';
 *   @Inject(COMMUNICATION_SERVICE) private readonly comm: ICommunicationService
 */

/** DI token for the main CommunicationService facade. */
export const COMMUNICATION_SERVICE = Symbol('COMMUNICATION_SERVICE');

/** DI token for the InputParserService. */
export const INPUT_PARSER_SERVICE = Symbol('INPUT_PARSER_SERVICE');

/** DI token for the PersonModelingService. */
export const PERSON_MODELING_SERVICE = Symbol('PERSON_MODELING_SERVICE');

/** DI token for the TheaterValidatorService. */
export const THEATER_VALIDATOR = Symbol('THEATER_VALIDATOR');

/** DI token for the SttService (speech-to-text). */
export const STT_SERVICE = Symbol('STT_SERVICE');

/** DI token for the TtsService (text-to-speech). */
export const TTS_SERVICE = Symbol('TTS_SERVICE');

/** DI token for the ResponseGeneratorService. */
export const RESPONSE_GENERATOR = Symbol('RESPONSE_GENERATOR');

/** DI token for the LlmContextAssemblerService. */
export const LLM_CONTEXT_ASSEMBLER = Symbol('LLM_CONTEXT_ASSEMBLER');

/** DI token for the SocialContingencyService. */
export const SOCIAL_CONTINGENCY = Symbol('SOCIAL_CONTINGENCY');

/** DI token for the ChatboxGateway. */
export const CHATBOX_GATEWAY = Symbol('CHATBOX_GATEWAY');
