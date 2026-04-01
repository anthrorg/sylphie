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
 *   STT_SERVICE            → DeepgramSttService
 *   TTS_SERVICE            → ElevenLabsTtsService
 *   LLM_SERVICE            → OllamaLlmService | AnthropicLlmService (via LLM_PROVIDER env)
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
 *   ConfigModule: LLM services read AppConfig for provider selection and keys.
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

import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../shared/config/app.config';
import { CommunicationService } from './communication.service';
import { InputParserService } from './input-parser/input-parser.service';
import { PersonModelingService } from './person-modeling/person-modeling.service';
import { TheaterValidatorService } from './theater-validator/theater-validator.service';
import { DeepgramSttService } from './voice/deepgram-stt.service';
import { ElevenLabsTtsService } from './voice/elevenlabs-tts.service';
import { AnthropicLlmService } from './llm/anthropic-llm.service';
import { OllamaLlmService } from './llm/ollama-llm.service';
import { ResponseGeneratorService } from './response-generator/response-generator.service';
import { LlmContextAssemblerService } from './response-generator/llm-context-assembler.service';
import { SocialContingencyService } from './social/social-contingency.service';
import { ChatboxGateway } from './chatbox/chatbox.gateway';
import { EVENTS_SERVICE } from '../events';
import { ACTION_OUTCOME_REPORTER, DRIVE_STATE_READER } from '../drive-engine';

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
      useClass: DeepgramSttService,
    },
    {
      provide: TTS_SERVICE,
      useClass: ElevenLabsTtsService,
    },
    {
      provide: LLM_SERVICE,
      useFactory: (
        configService: ConfigService<{ app: AppConfig }>,
        eventService: any,
        metricsReporter: any,
        driveStateReader: any,
      ) => {
        const config = configService.get<AppConfig>('app');
        const provider = config?.llm.provider ?? 'ollama';
        if (provider === 'anthropic') {
          return new AnthropicLlmService(configService, eventService, metricsReporter, driveStateReader);
        }
        return new OllamaLlmService(configService, eventService, metricsReporter, driveStateReader);
      },
      inject: [ConfigService, EVENTS_SERVICE, ACTION_OUTCOME_REPORTER, DRIVE_STATE_READER],
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
