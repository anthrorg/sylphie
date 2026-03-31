/**
 * CommunicationModule — NestJS module for Sylphie's Communication subsystem.
 *
 * CANON §Subsystem 2 (Communication): Input parsing, person modeling,
 * response generation via LLM, TTS/chatbox output.
 *
 * Provides:
 *   COMMUNICATION_SERVICE  → CommunicationService (main facade)
 *   INPUT_PARSER_SERVICE   → InputParserService
 *   PERSON_MODELING_SERVICE→ PersonModelingService
 *   THEATER_VALIDATOR      → TheaterValidatorService
 *   STT_SERVICE            → SttService (OpenAI Whisper)
 *   TTS_SERVICE            → TtsService (OpenAI TTS)
 *   LLM_SERVICE            → LlmServiceImpl (Anthropic Claude API)
 *
 * Exports:
 *   COMMUNICATION_SERVICE  — Decision Making calls generateResponse() and
 *                            initiateComment().
 *   INPUT_PARSER_SERVICE   — Exposed for Decision Making context assembly.
 *   LLM_SERVICE            — Learning and Planning inject ILlmService via
 *                            this token without a cross-subsystem import.
 *                            Those modules must declare CommunicationModule
 *                            in their imports array to receive this export.
 *
 * Import rationale:
 *   ConfigModule: LlmServiceImpl reads AppConfig for API key and model.
 *   KnowledgeModule: InputParserService resolves entities against the WKG.
 *   EventsModule: CommunicationService emits INPUT_RECEIVED, INPUT_PARSED,
 *                 RESPONSE_GENERATED, RESPONSE_DELIVERED events.
 *
 * Tokens defined in this file's module:
 *   LLM_SERVICE is imported from src/shared/types/llm.types.ts (not redefined
 *   here). CommunicationModule provides its implementation.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { LLM_SERVICE } from '../shared/types/llm.types';
import { DriveEngineModule } from '../drive-engine';
import { EventsModule } from '../events';
import { KnowledgeModule } from '../knowledge';
import {
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

import { CommunicationService } from './communication.service';
import { InputParserService } from './input-parser/input-parser.service';
import { PersonModelingService } from './person-modeling/person-modeling.service';
import { TheaterValidatorService } from './theater-validator/theater-validator.service';
import { SttService } from './voice/stt.service';
import { TtsService } from './voice/tts.service';
import { LlmServiceImpl } from './llm/llm.service';
import { ResponseGeneratorService } from './response-generator/response-generator.service';
import { LlmContextAssemblerService } from './response-generator/llm-context-assembler.service';
import { SocialContingencyService } from './social/social-contingency.service';
import { ChatboxGateway } from './chatbox/chatbox.gateway';

@Module({
  imports: [
    ConfigModule,
    DriveEngineModule, // Provides DRIVE_STATE_READER for pre-flight theater validation
    EventsModule, // TheaterValidatorService emits RESPONSE_GENERATED events; CommunicationService emits INPUT_RECEIVED et al.
    KnowledgeModule, // InputParserService needs WKG_SERVICE; PersonModelingService needs OTHER_KG_SERVICE
  ],
  providers: [
    {
      provide: COMMUNICATION_SERVICE,
      useClass: CommunicationService,
    },
    {
      provide: INPUT_PARSER_SERVICE,
      useClass: InputParserService,
    },
    {
      provide: PERSON_MODELING_SERVICE,
      useClass: PersonModelingService,
    },
    {
      provide: THEATER_VALIDATOR,
      useClass: TheaterValidatorService,
    },
    {
      provide: STT_SERVICE,
      useClass: SttService,
    },
    {
      provide: TTS_SERVICE,
      useClass: TtsService,
    },
    {
      provide: LLM_SERVICE,
      useClass: LlmServiceImpl,
    },
    {
      provide: RESPONSE_GENERATOR,
      useClass: ResponseGeneratorService,
    },
    {
      provide: LLM_CONTEXT_ASSEMBLER,
      useClass: LlmContextAssemblerService,
    },
    {
      provide: SOCIAL_CONTINGENCY,
      useClass: SocialContingencyService,
    },
    {
      provide: CHATBOX_GATEWAY,
      useClass: ChatboxGateway,
    },
  ],
  exports: [
    COMMUNICATION_SERVICE,
    INPUT_PARSER_SERVICE,
    LLM_SERVICE,
    STT_SERVICE,
    TTS_SERVICE,
    RESPONSE_GENERATOR,
    LLM_CONTEXT_ASSEMBLER,
    SOCIAL_CONTINGENCY,
    CHATBOX_GATEWAY,
  ],
})
export class CommunicationModule {}
