/**
 * CommunicationService — main facade for the Communication subsystem.
 *
 * Implements ICommunicationService. Orchestrates the full input-to-output
 * pipeline: STT, parsing, context assembly, LLM generation, theater
 * validation, and output delivery.
 *
 * CANON §Subsystem 2 (Communication): This service is the only entry point
 * for external input into Sylphie. It produces output but never makes action
 * selection decisions — those belong to Decision Making.
 *
 * Pipeline Flow:
 *
 * handleGuardianInput():
 *   1. Emit INPUT_RECEIVED event
 *   2. If voiceBuffer present: transcribe via SttService
 *   3. Parse input via InputParserService
 *   4. Update person model via PersonModelingService
 *   5. Check for Social contingency (guardian response to Sylphie comment)
 *   6. Emit INPUT_PARSED event
 *   7. Return ParsedInput to Decision Making
 *
 * generateResponse():
 *   1. Read current drive state via IDriveStateReader
 *   2. Generate response via ResponseGeneratorService (includes Theater validation)
 *   3. Synthesize audio via TtsService (graceful degradation)
 *   4. Broadcast response via ChatboxGateway
 *   5. Report Type 2 cost to Drive Engine via IActionOutcomeReporter
 *   6. Emit RESPONSE_DELIVERED event
 *   7. Update person model from conversation
 *
 * initiateComment():
 *   1. Read current drive state
 *   2. Generate unprompted comment via ResponseGeneratorService
 *   3. Track for Social contingency (30s window)
 *   4. Broadcast via ChatboxGateway as Sylphie-initiated
 *   5. Return response
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

import type { DriveSnapshot, DriveName } from '../shared/types/drive.types';
import {
  DRIVE_STATE_READER,
  ACTION_OUTCOME_REPORTER,
} from '../drive-engine';
import type {
  IDriveStateReader,
  IActionOutcomeReporter,
} from '../drive-engine/interfaces/drive-engine.interfaces';
import type {
  ICommunicationService,
  GuardianInput,
  CommunicationResult,
  ActionIntent,
  GeneratedResponse,
  ParsedInput,
} from './interfaces/communication.interfaces';

// Import internal service tokens
import {
  INPUT_PARSER_SERVICE,
  RESPONSE_GENERATOR,
  PERSON_MODELING_SERVICE,
  STT_SERVICE,
  TTS_SERVICE,
  CHATBOX_GATEWAY,
  SOCIAL_CONTINGENCY,
} from './communication.tokens';

// Import service interfaces
import type { IInputParserService } from './interfaces/communication.interfaces';
import type { IPersonModelingService } from './interfaces/communication.interfaces';
import type { ISttService } from './interfaces/communication.interfaces';
import type { ITtsService } from './interfaces/communication.interfaces';
import { ResponseGeneratorService } from './response-generator/response-generator.service';
import { ChatboxGateway } from './chatbox/chatbox.gateway';
import { SocialContingencyService } from './social/social-contingency.service';

// Import event service
import { EVENTS_SERVICE } from '../events';
import type { IEventService } from '../events';

// Import error types
import { STTDegradationError } from './voice/voice.errors';
import { TTSDegradationError } from './voice/voice.errors';

@Injectable()
export class CommunicationService implements ICommunicationService {
  private readonly logger = new Logger(CommunicationService.name);

  constructor(
    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,
    @Inject(ACTION_OUTCOME_REPORTER)
    private readonly actionOutcomeReporter: IActionOutcomeReporter,
    @Inject(INPUT_PARSER_SERVICE)
    private readonly inputParser: IInputParserService,
    @Inject(RESPONSE_GENERATOR)
    private readonly responseGenerator: ResponseGeneratorService,
    @Inject(PERSON_MODELING_SERVICE)
    private readonly personModeling: IPersonModelingService,
    @Inject(STT_SERVICE)
    private readonly sttService: ISttService,
    @Inject(TTS_SERVICE)
    private readonly ttsService: ITtsService,
    @Inject(CHATBOX_GATEWAY)
    private readonly chatbox: ChatboxGateway,
    @Inject(SOCIAL_CONTINGENCY)
    private readonly socialContingency: SocialContingencyService,
    @Inject(EVENTS_SERVICE)
    private readonly eventService: IEventService,
  ) {}

  /**
   * Handle raw input from the guardian: parse, optionally generate a response,
   * and emit all relevant TimescaleDB events.
   *
   * Pipeline:
   * 1. Emit INPUT_RECEIVED event
   * 2. If voiceBuffer present: transcribe via SttService
   * 3. Parse input via InputParserService
   * 4. Update person model via PersonModelingService
   * 5. Check for Social contingency (guardian response to Sylphie comment)
   * 6. Emit INPUT_PARSED event
   * 7. Return CommunicationResult to caller
   *
   * @param input - Raw guardian input, typed or transcribed.
   * @returns Structured result including parse and event correlation IDs.
   */
  async handleGuardianInput(input: GuardianInput): Promise<CommunicationResult> {
    const eventIds: string[] = [];
    let parsedInput: ParsedInput | null = null;

    try {
      // Step 1: Emit INPUT_RECEIVED event
      const inputReceivedEventId = randomUUID();
      // Get drive snapshot for event metadata
      const driveSnapshot = await this.driveStateReader.getCurrentState();
      try {
        await this.eventService.record({
          type: 'INPUT_RECEIVED',
          timestamp: new Date(),
          subsystem: 'COMMUNICATION',
          sessionId: input.sessionId,
          driveSnapshot,
          schemaVersion: 1,
        } as any);
        eventIds.push(inputReceivedEventId);
      } catch (eventError) {
        this.logger.warn(
          `Failed to emit INPUT_RECEIVED event: ${eventError instanceof Error ? eventError.message : String(eventError)}`,
        );
      }

      // Step 2: Transcribe voice if present (graceful degradation)
      let text = input.text;
      let transcriptionConfidence: number | null = null;

      if (input.voiceBuffer) {
        try {
          const transcriptionResult = await this.sttService.transcribe(input.voiceBuffer);
          text = transcriptionResult.text;
          transcriptionConfidence = transcriptionResult.confidence;
          this.logger.debug(
            `STT transcription: confidence=${transcriptionConfidence}, text="${text.substring(0, 100)}"`,
          );
        } catch (sttError) {
          if (sttError instanceof STTDegradationError) {
            this.logger.warn(
              `STT degradation: ${sttError.message}. Falling back to empty text.`,
            );
            // Fall through with empty text; parsing will handle empty input
            text = '';
          } else {
            this.logger.error(
              `Unexpected STT error: ${sttError instanceof Error ? sttError.message : String(sttError)}`,
            );
            text = '';
          }
        }
      }

      // Step 3: Parse input
      const guardianInputForParsing: GuardianInput = {
        text,
        voiceBuffer: undefined, // Don't pass buffer to parser
        sessionId: input.sessionId,
        timestamp: input.timestamp,
      };

      parsedInput = await this.inputParser.parse(guardianInputForParsing);
      this.logger.debug(
        `Input parsed: intent=${parsedInput.intentType}, confidence=${parsedInput.confidence}, ` +
          `entities=${parsedInput.entities.length}`,
      );

      // Step 4: Update person model from conversation
      const personId = 'Person_Jim'; // TODO: Extract from input or auth context
      try {
        // For now, we don't generate a response here in handleGuardianInput
        // The response generation happens in generateResponse() via Decision Making
        // But we still update the person model with the input data
        // We'll need to generate a dummy response for the update
        // For now, skip person model update as it requires a GeneratedResponse
        this.logger.debug(
          `Person model update deferred (handled in generateResponse)`,
        );
      } catch (modelError) {
        this.logger.warn(
          `Failed to update person model: ${modelError instanceof Error ? modelError.message : String(modelError)}`,
        );
        // Non-fatal; continue processing
      }

      // Step 5: Check for Social contingency (guardian response to Sylphie comment)
      const contingencyResult = this.socialContingency.checkGuardianResponse(
        input.timestamp,
        input.sessionId,
        { sessionId: input.sessionId } as DriveSnapshot, // Simplified drive snapshot
      );
      if (contingencyResult) {
        this.logger.debug(
          `Social contingency detected: latencyMs=${contingencyResult.latencyMs}`,
        );
      }

      // Step 6: Emit INPUT_PARSED event
      const inputParsedEventId = randomUUID();
      try {
        await this.eventService.record({
          type: 'INPUT_PARSED',
          timestamp: new Date(),
          subsystem: 'COMMUNICATION',
          sessionId: input.sessionId,
          driveSnapshot,
          schemaVersion: 1,
        } as any);
        eventIds.push(inputParsedEventId);
      } catch (eventError) {
        this.logger.warn(
          `Failed to emit INPUT_PARSED event: ${eventError instanceof Error ? eventError.message : String(eventError)}`,
        );
      }

      // Step 7: Return CommunicationResult
      return {
        parsed: parsedInput,
        responseGenerated: false, // Response is generated by Decision Making, not here
        eventIds,
      };
    } catch (error) {
      this.logger.error(
        `handleGuardianInput failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Return safe fallback parse
      const fallbackParse: ParsedInput = {
        intentType: 'STATEMENT',
        entities: [],
        guardianFeedbackType: 'none',
        rawText: input.text,
        confidence: 0.2,
        contextReferences: [],
      };
      return {
        parsed: fallbackParse,
        responseGenerated: false,
        eventIds,
      };
    }
  }

  /**
   * Generate a response for a Decision-Making-dispatched ActionIntent.
   *
   * Pipeline:
   * 1. Read current drive state via IDriveStateReader
   * 2. Generate response via ResponseGeneratorService (includes Theater validation)
   * 3. Synthesize audio via TtsService (graceful degradation)
   * 4. Broadcast response via ChatboxGateway
   * 5. Report Type 2 cost to Drive Engine via IActionOutcomeReporter
   * 6. Emit RESPONSE_DELIVERED event
   * 7. Update person model from conversation
   *
   * @param intent - The action intent from Decision Making.
   * @returns The validated generated response ready for output delivery.
   */
  async generateResponse(intent: ActionIntent): Promise<GeneratedResponse> {
    const conversationId = randomUUID();
    const personId = 'Person_Jim'; // TODO: Extract from auth context

    try {
      this.logger.debug(
        `Generating response for action: ${intent.actionType}, drive: ${intent.motivatingDrive}`,
      );

      // Step 1: Read current drive state (inject for context)
      // Note: ResponseGeneratorService also reads drive state
      const currentDriveState = await this.driveStateReader.getCurrentState();

      // Step 2: Generate response via ResponseGeneratorService
      const response = await this.responseGenerator.generate(
        intent,
        conversationId,
        personId,
      );

      this.logger.debug(
        `Response generated: ${response.text.length} chars, theater=${response.theaterCheck.passed}`,
      );

      // Step 3: Synthesize audio (graceful degradation on TTS failure)
      let audioBuffer: Buffer | undefined;
      try {
        const synthesisResult = await this.ttsService.synthesize(response.text);
        audioBuffer = synthesisResult.audioBuffer;
        this.logger.debug(`TTS synthesis: ${synthesisResult.durationMs}ms`);
      } catch (ttsError) {
        if (ttsError instanceof TTSDegradationError) {
          this.logger.warn(
            `TTS degradation: ${ttsError.message}. Response will be text-only.`,
          );
        } else {
          this.logger.error(
            `Unexpected TTS error: ${ttsError instanceof Error ? ttsError.message : String(ttsError)}`,
          );
        }
        // Continue with text-only delivery; audioBuffer remains undefined
      }

      // Step 4: Broadcast response via ChatboxGateway
      // TODO: Get threadId from conversation context
      const threadId = conversationId;
      this.chatbox.broadcastResponse(threadId, response.text, new Date());

      // Step 5: Report Type 2 cost to Drive Engine
      // Note: ResponseGeneratorService already emits RESPONSE_GENERATED event with cost metrics
      // Report outcome for drive system knowledge
      try {
        await this.actionOutcomeReporter.reportOutcome({
          actionId: conversationId,
          actionType: 'GENERATE_RESPONSE',
          success: response.theaterCheck.passed,
          driveEffects: {}, // No direct drive effects from response generation
          feedbackSource: 'LLM_GENERATED',
          theaterCheck: {
            expressionType: response.theaterCheck.passed ? 'none' : 'pressure',
            correspondingDrive: null,
            driveValue: null,
            isTheatrical: !response.theaterCheck.passed,
          },
        });
        this.logger.debug(
          `Type 2 cost reported: latency=${response.latencyMs}ms, tokens=${response.tokensUsed}`,
        );
      } catch (outcomeError) {
        this.logger.warn(
          `Failed to report outcome to Drive Engine: ${outcomeError instanceof Error ? outcomeError.message : String(outcomeError)}`,
        );
      }

      // Step 6: Emit RESPONSE_DELIVERED event
      try {
        await this.eventService.record({
          type: 'RESPONSE_DELIVERED',
          timestamp: new Date(),
          subsystem: 'COMMUNICATION',
          sessionId: intent.driveSnapshot.sessionId || conversationId,
          driveSnapshot: response.driveSnapshot,
          schemaVersion: 1,
        } as any);
      } catch (eventError) {
        this.logger.warn(
          `Failed to emit RESPONSE_DELIVERED event: ${eventError instanceof Error ? eventError.message : String(eventError)}`,
        );
      }

      // Step 7: Update person model from conversation
      try {
        // Create a minimal ParsedInput for person model update
        // In practice, this would be the original guardian input that triggered this response
        const dummyInput: ParsedInput = {
          intentType: 'STATEMENT',
          entities: [],
          guardianFeedbackType: 'none',
          rawText: 'conversation context',
          confidence: 0.5,
          contextReferences: [],
        };
        await this.personModeling.updateFromConversation(
          personId,
          dummyInput,
          response,
        );
      } catch (modelError) {
        this.logger.warn(
          `Failed to update person model: ${modelError instanceof Error ? modelError.message : String(modelError)}`,
        );
        // Non-fatal; continue
      }

      // Return the response with the audio buffer attached so callers
      // (e.g. ConversationGateway) can forward it to the browser.
      // audioBuffer is undefined when TTS failed — callers must handle that case.
      return { ...response, audioBuffer };
    } catch (error) {
      this.logger.error(
        `generateResponse failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Attempt to generate a spontaneous comment driven by current drive state.
   *
   * Pipeline:
   * 1. Read current drive state
   * 2. Generate unprompted comment via ResponseGeneratorService
   * 3. Validate via Theater Prohibition (already done in ResponseGeneratorService)
   * 4. Track for Social contingency (30s window)
   * 5. Broadcast via ChatboxGateway as Sylphie-initiated
   * 6. Return response or null if Shrug Imperative applies
   *
   * Returns null when Theater Prohibition validator determines no authentic
   * comment can be produced (Shrug Imperative, Standard 4).
   *
   * @param driveSnapshot - Current drive state that motivated the comment.
   * @returns A validated response if one can be produced; null otherwise.
   */
  async initiateComment(driveSnapshot: DriveSnapshot): Promise<GeneratedResponse | null> {
    const utteranceId = randomUUID();
    const threadId = randomUUID();
    const personId = 'Person_Jim'; // TODO: Extract from context

    try {
      this.logger.debug(
        `Initiating spontaneous comment`,
      );

      // Step 1: Read current drive state
      const currentDriveState = await this.driveStateReader.getCurrentState();

      // Determine motivating drive from pressure vector (highest pressure)
      let primaryDrive: DriveName = 'Social' as any; // Default (cast for now)
      let maxPressure = 0;
      if (currentDriveState.pressureVector) {
        for (const [driveName, pressure] of Object.entries(currentDriveState.pressureVector)) {
          if (pressure > maxPressure) {
            maxPressure = pressure;
            primaryDrive = driveName as any; // Cast because driveName is string
          }
        }
      }

      // Step 2: Create ActionIntent for spontaneous comment
      const intent: ActionIntent = {
        actionType: 'INITIATE_COMMENT',
        content: `Generate a spontaneous, natural comment reflecting current state.`,
        motivatingDrive: primaryDrive,
        driveSnapshot: currentDriveState,
      };

      // Step 3: Generate response via ResponseGeneratorService
      const response = await this.responseGenerator.generate(
        intent,
        threadId,
        personId,
      );

      // Step 4: Check if response passed Theater Prohibition
      if (!response.theaterCheck.passed) {
        this.logger.debug(
          `Theater Prohibition prevented comment: ${response.theaterCheck.violations.length} violations`,
        );
        // Shrug Imperative (Standard 4): Return null when no authentic comment can be produced
        return null;
      }

      // Step 5: Track for Social contingency (30s window)
      this.socialContingency.trackSylphieInitiated(utteranceId, new Date());
      this.logger.debug(`Social contingency tracking started: ${utteranceId}`);

      // Step 6: Broadcast via ChatboxGateway as Sylphie-initiated
      this.chatbox.broadcastInitiatedComment(
        threadId,
        response.text,
        primaryDrive,
        new Date(),
      );

      // Step 7: Emit SOCIAL_COMMENT_INITIATED event
      try {
        await this.eventService.record({
          type: 'SOCIAL_COMMENT_INITIATED',
          timestamp: new Date(),
          subsystem: 'COMMUNICATION',
          sessionId: driveSnapshot.sessionId,
          driveSnapshot: response.driveSnapshot,
          schemaVersion: 1,
        } as any);
      } catch (eventError) {
        this.logger.warn(
          `Failed to emit SOCIAL_COMMENT_INITIATED event: ${eventError instanceof Error ? eventError.message : String(eventError)}`,
        );
      }

      this.logger.debug(
        `Spontaneous comment delivered: ${response.text.length} chars`,
      );

      return response;
    } catch (error) {
      this.logger.error(
        `initiateComment failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
