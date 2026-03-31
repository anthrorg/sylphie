/**
 * ResponseGeneratorService — orchestrates LLM response generation and theater validation.
 *
 * Implements the core response generation pipeline: context assembly, LLM invocation,
 * theater validation, and cost reporting. Collaborates with LlmContextAssemblerService
 * to construct the full context for the LLM.
 *
 * CANON §Subsystem 2 (Communication): Response generation is the primary output path.
 * This service is called by CommunicationService when an ActionIntent requires LLM-based
 * response generation.
 *
 * Type 2 cost reporting: After LLM generation, this service reports latencyMs and
 * tokensUsed to the Drive Engine via the Events subsystem (Standard 3: Type 2 must
 * always carry explicit cost).
 *
 * Theater Prohibition (CANON Standard 1): Every generated response is validated
 * against the current drive state before delivery. If a theater violation is detected,
 * the service attempts one regeneration with a stronger drive constraint. If theater
 * persists after retry, a minimal neutral response is delivered.
 *
 * Pipeline:
 * 1. Assemble full LLM context via LlmContextAssemblerService.
 * 2. Call the LLM.
 * 3. Validate via TheaterValidatorService.
 * 4. If Theater detected: regenerate with stronger constraint (max 1 retry).
 * 5. If still Theater: deliver neutral fallback response.
 * 6. Emit RESPONSE_GENERATED event to TimescaleDB with cost data.
 * 7. Return GeneratedResponse with text, theaterCheck, cost, latency.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';

import { LLM_SERVICE } from '../../shared/types/llm.types';
import { THEATER_VALIDATOR, LLM_CONTEXT_ASSEMBLER } from '../communication.tokens';
import { EVENTS_SERVICE } from '../../events/events.tokens';

import type { ActionIntent, GeneratedResponse, ITheaterValidator } from '../interfaces/communication.interfaces';
import type { ILlmService, LlmRequest } from '../../shared/types/llm.types';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { LlmContextAssemblerService } from './llm-context-assembler.service';

@Injectable()
export class ResponseGeneratorService {
  private readonly logger = new Logger(ResponseGeneratorService.name);

  constructor(
    @Inject(LLM_SERVICE) private readonly llmService: ILlmService,
    @Inject(THEATER_VALIDATOR) private readonly theaterValidator: ITheaterValidator,
    @Inject(LLM_CONTEXT_ASSEMBLER) private readonly contextAssembler: LlmContextAssemblerService,
    @Inject(EVENTS_SERVICE) private readonly events: IEventService,
  ) {}

  /**
   * Generate a response for an ActionIntent from Decision Making.
   *
   * Pipeline:
   * 1. Assemble full LLM context via LlmContextAssemblerService.
   * 2. Call the LLM.
   * 3. Validate via TheaterValidatorService.
   * 4. If Theater detected: regenerate with stronger constraint (max 1 retry).
   * 5. If still Theater: deliver neutral fallback response.
   * 6. Emit RESPONSE_GENERATED event to TimescaleDB with cost data.
   * 7. Return GeneratedResponse with text, theaterCheck, cost, latency.
   *
   * @param intent - The action intent from Decision Making.
   * @param driveState - Current drive snapshot at time of generation.
   * @param conversationId - For context assembly and correlation.
   * @param personId - For person model retrieval.
   * @returns The validated generated response ready for delivery.
   * @throws Error if LLM is unavailable or critical infrastructure fails.
   */
  async generate(
    intent: ActionIntent,
    conversationId: string,
    personId: string,
  ): Promise<GeneratedResponse> {
    const startTime = Date.now();
    const driveState = intent.driveSnapshot;

    this.logger.debug(
      `Generating response for action ${intent.actionType}, drive: ${intent.motivatingDrive}`,
    );

    try {
      // Step 1: Assemble LLM context
      const llmRequest = await this.contextAssembler.assemble(
        intent,
        driveState,
        conversationId,
        personId,
      );

      // Step 2: Call the LLM
      let llmResponse = await this.llmService.complete(llmRequest);
      let responseText = llmResponse.content;
      let totalLatencyMs = llmResponse.latencyMs;
      let totalTokensUsed = llmResponse.tokensUsed.prompt + llmResponse.tokensUsed.completion;

      // Step 3: Validate via Theater Prohibition
      let theaterCheck = await this.theaterValidator.validate(responseText, driveState);

      // Step 4: Handle theater violations with single retry
      if (!theaterCheck.passed) {
        this.logger.warn(
          `Theater Prohibition violation detected (${theaterCheck.violations.length} violations). ` +
            `Attempting regeneration with stronger constraint.`,
        );

        // Attempt single retry with stricter prompt
        const retryRequest = this.constructStrictTheaterRequest(llmRequest, driveState);
        try {
          const retryResponse = await this.llmService.complete(retryRequest);
          const retryTheaterCheck = await this.theaterValidator.validate(
            retryResponse.content,
            driveState,
          );

          // Use retry if it passes theater validation
          if (retryTheaterCheck.passed) {
            responseText = retryResponse.content;
            totalLatencyMs += retryResponse.latencyMs;
            totalTokensUsed += retryResponse.tokensUsed.prompt + retryResponse.tokensUsed.completion;
            theaterCheck = retryTheaterCheck;
            this.logger.debug('Theater violation resolved on retry.');
          } else {
            // Retry also failed theater; use fallback neutral response
            this.logger.warn(
              `Theater violation persists after retry (${retryTheaterCheck.violations.length} violations). ` +
                `Falling back to neutral response.`,
            );
            responseText = this.constructNeutralFallback(intent);
            totalTokensUsed += retryResponse.tokensUsed.prompt + retryResponse.tokensUsed.completion;
            totalLatencyMs += retryResponse.latencyMs;
            // Re-validate fallback
            theaterCheck = await this.theaterValidator.validate(responseText, driveState);
          }
        } catch (retryError) {
          // LLM unavailable or rate limited on retry; use neutral fallback
          this.logger.warn(
            `Retry LLM call failed: ${retryError instanceof Error ? retryError.message : String(retryError)}. ` +
              `Falling back to neutral response.`,
          );
          responseText = this.constructNeutralFallback(intent);
          theaterCheck = await this.theaterValidator.validate(responseText, driveState);
        }
      }

      // Step 6: Emit RESPONSE_GENERATED event to TimescaleDB
      const totalLatency = Date.now() - startTime;
      await this.emitResponseGeneratedEvent(
        responseText,
        driveState,
        theaterCheck,
        totalTokensUsed,
        totalLatency,
        conversationId,
      );

      // Step 7: Return GeneratedResponse
      const generatedResponse: GeneratedResponse = {
        text: responseText,
        driveSnapshot: driveState,
        theaterCheck,
        tokensUsed: totalTokensUsed,
        latencyMs: totalLatency,
      };

      this.logger.debug(
        `Response generated: ${responseText.length} chars, theater: ${theaterCheck.passed ? 'PASS' : 'FAIL'}, ` +
          `tokens: ${totalTokensUsed}, latency: ${totalLatency}ms`,
      );

      return generatedResponse;
    } catch (error) {
      this.logger.error(
        `Response generation failed: ${error instanceof Error ? error.message : String(error)}`,
        { actionType: intent.actionType },
      );
      throw error;
    }
  }

  /**
   * Construct a strict Theater Prohibition override request for retry attempts.
   *
   * Strengthens the Theater Prohibition instruction in the system prompt by:
   * - Explicitly forbidding pressure expressions for drives < 0.1
   * - Explicitly forbidding relief expressions for drives > 0.2
   * - Adding directive to respond with factual, emotionally neutral content
   *
   * @param baseRequest - The original LlmRequest
   * @param driveState - Current drive snapshot
   * @returns Modified LlmRequest with stricter Theater constraints
   */
  private constructStrictTheaterRequest(baseRequest: LlmRequest, driveState: any): LlmRequest {
    const strictPrompt =
      baseRequest.systemPrompt +
      '\n\n' +
      'STRICT THEATER PROHIBITION OVERRIDE (Retry Attempt):\n' +
      'Your previous response was flagged for not matching your actual emotional state.\n' +
      'Respond with factual, emotionally neutral content. Avoid any emotional language ' +
      'unless it directly matches your current motivational state:\n' +
      '- FORBIDDEN: Expressing distress, need, or pressure you do not feel.\n' +
      '- FORBIDDEN: Expressing relief or contentment that is not earned.\n' +
      '- ALLOWED: Simple factual statements without emotional register.\n' +
      'Priority: authenticity over expressiveness.';

    return {
      ...baseRequest,
      systemPrompt: strictPrompt,
    };
  }

  /**
   * Construct a minimal neutral fallback response when theater persists.
   *
   * Returns a short, emotionally minimal response that acknowledges the intent
   * without expressing emotions that might violate Theater Prohibition.
   *
   * @param intent - The original action intent
   * @returns Minimal neutral response text
   */
  private constructNeutralFallback(intent: ActionIntent): string {
    // Extract action type to customize fallback slightly
    const actionType = intent.actionType.toLowerCase();

    if (actionType.includes('question')) {
      return 'I acknowledge your question. I am processing information about this.';
    } else if (actionType.includes('statement')) {
      return 'I have received this information. Thank you for sharing.';
    } else if (actionType.includes('comment')) {
      return 'I have noted this. Let me think about it further.';
    } else {
      return 'I am considering this. I will respond when I have clarity on my state.';
    }
  }

  /**
   * Emit a RESPONSE_GENERATED event to TimescaleDB with cost data.
   *
   * Records the generated response, theater validation result, and Type 2 cost
   * metrics for Drive Engine cost attribution and behavioral audit.
   *
   * @param responseText - The generated response text
   * @param driveState - Current drive snapshot
   * @param theaterCheck - Theater validation result
   * @param tokensUsed - Total tokens consumed (prompt + completion)
   * @param latencyMs - End-to-end latency in milliseconds
   * @param correlationId - For tracing from INPUT to RESPONSE_DELIVERED
   */
  private async emitResponseGeneratedEvent(
    responseText: string,
    driveState: any,
    theaterCheck: any,
    tokensUsed: number,
    latencyMs: number,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.events.record({
        type: 'RESPONSE_GENERATED',
        subsystem: 'COMMUNICATION',
        sessionId: driveState.sessionId,
        correlationId,
        driveSnapshot: driveState,
        schemaVersion: 1,
        provenance: 'LLM_GENERATED',
        // Additional payload fields (passed to event store)
        payload: {
          theaterPassed: theaterCheck.passed,
          violationCount: theaterCheck.violations.length,
          tokensUsed,
          latencyMs,
          textLength: responseText.length,
        },
      } as any);

      this.logger.debug(
        `RESPONSE_GENERATED event emitted: theater=${theaterCheck.passed}, tokens=${tokensUsed}, latency=${latencyMs}ms`,
      );
    } catch (error) {
      // Log but do not rethrow; event recording failure should not block response delivery
      this.logger.warn(
        `Failed to emit RESPONSE_GENERATED event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
