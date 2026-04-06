/**
 * ActionHandlerRegistryService — Dispatcher for action steps in the EXECUTING state.
 *
 * CANON §Subsystem 1 (Decision Making): The Executor Engine transitions to EXECUTING
 * when an ArbitrationResult of TYPE_1 or TYPE_2 is committed. The action procedure's
 * actionSequence is dispatched step-by-step through this registry.
 *
 * Responsibilities:
 *   - Maintain a map of stepType → handler functions
 *   - Register built-in handlers for the four core step types during initialization
 *   - Dispatch action steps to their registered handler at runtime
 *   - Warn and return null when no handler exists for a step type
 *
 * Built-in handlers are stubs that log intent. They will be replaced with wired
 * implementations as the dependent services come online:
 *   - LLM_GENERATE: will delegate to ILlmService (Communication module)
 *   - WKG_QUERY:    will delegate to IWkgService (Knowledge module)
 *   - TTS_SPEAK:    will delegate to the TTS service (Communication module)
 *   - LOG_EVENT:    logs the payload (functional now, no external dependency)
 *
 * CANON §Interface-First Design: The handler function type is defined here.
 * When ILlmService and IWkgService are injected later, the registry handlers
 * will be replaced via re-registration — no new injection tokens needed.
 *
 * No external DI dependencies. All handler implementations in this file are
 * stubs with clear TODOs for wiring. The registry itself is fully functional.
 *
 * Dependencies: @sylphie/shared (ActionStep), NestJS Logger.
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { type ActionStep, type SensoryFrame, type CognitiveContext, LLM_SERVICE, type ILlmService } from '@sylphie/shared';
import { WkgContextService } from '../wkg/wkg-context.service';

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

/**
 * Cycle context passed to action step handlers during execution.
 *
 * Carries the current sensory frame (with raw data from the fused stream)
 * and the cognitive context (episodes, drive state, gap types) so handlers
 * can build prompts and queries from the actual stream content.
 */
export interface ActionCycleContext {
  /** The SensoryFrame for this cycle — carries raw modality data in frame.raw. */
  readonly frame: SensoryFrame;

  /** Assembled cognitive context with episodes, drive state, and gap types. */
  readonly cognitiveContext: CognitiveContext;

  /** One-line summary of the input extracted by ProcessInput. */
  readonly inputSummary: string;
}

/**
 * A handler function for a single action step type.
 *
 * Receives the ActionStep (including its params) and the cycle context
 * carrying the current sensory frame and cognitive state. Returns a result
 * payload that may carry output data (e.g., the LLM-generated text).
 * Returning null signals the step produced no usable output.
 *
 * Handlers must not throw for expected failure modes. They should catch
 * expected errors internally and return null (with appropriate logging).
 */
export type ActionStepHandler = (
  step: ActionStep,
  cycleContext: ActionCycleContext,
) => Promise<Record<string, unknown> | null>;

// ---------------------------------------------------------------------------
// ActionHandlerRegistryService
// ---------------------------------------------------------------------------

@Injectable()
export class ActionHandlerRegistryService {
  private readonly logger = new Logger(ActionHandlerRegistryService.name);

  /** Internal map from stepType string to handler function. */
  private readonly handlers = new Map<string, ActionStepHandler>();

  constructor(
    @Optional()
    @Inject(LLM_SERVICE)
    private readonly llmService: ILlmService | null,

    @Optional()
    private readonly wkgContext: WkgContextService | null,
  ) {
    this.registerBuiltins();
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a handler function for the given step type.
   *
   * If a handler already exists for the step type, it is overwritten. This
   * is intentional — it allows built-in stub handlers to be replaced with
   * wired implementations once their dependencies are available (e.g., after
   * ILlmService is injected into the module).
   *
   * @param stepType - The step type string to register the handler for.
   * @param handler  - The async handler function to call for this step type.
   */
  register(stepType: string, handler: ActionStepHandler): void {
    this.handlers.set(stepType, handler);
    this.logger.debug(`Handler registered for step type: ${stepType}`);
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  /**
   * Dispatch an action step to its registered handler.
   *
   * Looks up the handler for step.stepType. If found, calls it and returns
   * the result. If no handler is registered, logs a warning and returns null.
   *
   * The executor engine calls this for each step in an ActionProcedure's
   * actionSequence in index order. Steps may produce output that later steps
   * in the same procedure can use — but output chaining between steps is
   * managed by the executor, not by this registry.
   *
   * @param actionStep   - The step to dispatch.
   * @param cycleContext  - Current cycle's sensory frame and cognitive context.
   * @returns The handler's return value, or null if no handler was found.
   */
  async execute(
    actionStep: ActionStep,
    cycleContext: ActionCycleContext,
  ): Promise<Record<string, unknown> | null> {
    const handler = this.handlers.get(actionStep.stepType);

    if (!handler) {
      this.logger.warn(
        `No handler registered for step type: "${actionStep.stepType}" ` +
          `(step index: ${actionStep.index}). Returning null.`,
      );
      return null;
    }

    return handler(actionStep, cycleContext);
  }

  // ---------------------------------------------------------------------------
  // Built-in handler registration
  // ---------------------------------------------------------------------------

  /**
   * Register the four core built-in step type handlers.
   *
   * Called once during construction. Handlers are stubs — they log intent
   * but do not yet invoke real services. They will be re-registered (via
   * register()) once the dependent services are available.
   *
   * Stub behavior is explicit and clearly logged. The memory note
   * [No stubs without flagging] is observed: each stub logs a warning
   * that it is unimplemented.
   */
  private registerBuiltins(): void {
    // LLM_GENERATE — delegates to ILlmService using cycle context from the fused stream
    this.handlers.set('LLM_GENERATE', async (step, cycleCtx) => {
      if (!this.llmService || !this.llmService.isAvailable()) {
        this.logger.warn(
          `LLM generation requested (step ${step.index}) but LLM service ` +
            `${!this.llmService ? 'not injected' : 'unavailable'}. Returning null.`,
        );
        return null;
      }

      // Extract the instruction from the action step params.
      const instruction = (step.params['instruction'] as string) ?? '';

      // Pull raw text from the fused stream's preserved raw data.
      const rawText = cycleCtx.frame.raw['text'] as string | undefined;
      const inputText = rawText ?? cycleCtx.inputSummary;

      // Build recent episode context for the system prompt.
      const recentEpisodeSummaries = cycleCtx.cognitiveContext.recentEpisodes
        .slice(0, 5)
        .map((ep) => ep.inputSummary)
        .filter((s) => s.length > 0)
        .join('\n');

      // Build the drive state summary for authentic expression (Theater Prohibition).
      const drives = cycleCtx.cognitiveContext.driveSnapshot.pressureVector;
      const driveLines = Object.entries(drives)
        .filter(([, v]) => v > 0.2)
        .map(([name, v]) => `${name}: ${(v as number).toFixed(2)}`)
        .join(', ');

      // Read person model from the fused stream (Other Evaluation per architecture).
      const personModel = cycleCtx.frame.raw['person_model'] as
        { personId?: string; knownFacts?: string[]; interactionSummary?: string } | null | undefined;

      const personContext = personModel?.knownFacts?.length
        ? `About the person I'm talking to (${personModel.personId}): ${personModel.knownFacts.join('; ')}`
        : '';

      const systemPrompt = [
        'You are Sylphie, a developing cognitive being. Respond authentically and concisely.',
        instruction ? `Task: ${instruction}` : '',
        personContext,
        driveLines ? `Current internal state: ${driveLines}` : '',
        recentEpisodeSummaries ? `Recent context:\n${recentEpisodeSummaries}` : '',
      ].filter(Boolean).join('\n\n');

      // Build messages array with conversation history from the fused stream.
      const conversationHistory = cycleCtx.frame.raw['conversation_history'] as
        Array<{ role: 'user' | 'assistant'; content: string }> | undefined;

      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      if (conversationHistory && conversationHistory.length > 0) {
        messages.push(...conversationHistory);
      }
      // Append the current input as the latest user message.
      const currentInput = inputText || instruction;
      if (currentInput) {
        // Avoid duplicating if conversation history already ends with this text.
        const lastMsg = messages[messages.length - 1];
        if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== currentInput) {
          messages.push({ role: 'user', content: currentInput });
        }
      }

      try {
        const response = await this.llmService.complete({
          messages,
          systemPrompt,
          maxTokens: 256,
          temperature: 0.7,
          metadata: {
            callerSubsystem: 'COMMUNICATION',
            purpose: 'LLM_GENERATE_ACTION_STEP',
            sessionId: cycleCtx.cognitiveContext.driveSnapshot.sessionId,
          },
        });

        this.logger.debug(
          `LLM_GENERATE complete: ${response.tokensUsed.completion} tokens, ${response.latencyMs}ms`,
        );

        return {
          content: response.content,
          tokensUsed: response.tokensUsed,
          latencyMs: response.latencyMs,
          model: response.model,
        };
      } catch (err) {
        this.logger.error(
          `LLM_GENERATE failed (step ${step.index}): ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    });

    // WKG_QUERY — queries the World Knowledge Graph via WkgContextService
    this.handlers.set('WKG_QUERY', async (step, _cycleCtx) => {
      if (!this.wkgContext) {
        this.logger.warn(`WKG query requested (step ${step.index}) but WkgContextService unavailable.`);
        return null;
      }

      const query = (step.params['query'] as string) ?? '';
      const entityId = step.params['entity_id'] as string | undefined;

      try {
        if (entityId) {
          const facts = await this.wkgContext.getEntityFacts(entityId);
          return { entityId, facts, count: facts.length };
        }

        const entities = await this.wkgContext.queryEntities(query);
        return {
          query,
          entities: entities.map((e) => ({ id: e.nodeId, label: e.label, type: e.nodeType, confidence: e.confidence })),
          count: entities.length,
        };
      } catch (err) {
        this.logger.error(`WKG_QUERY failed (step ${step.index}): ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    });

    // TTS_SPEAK — TTS is handled by CommunicationService in the delivery path.
    // This handler exists for procedures that have an explicit TTS step in their
    // action sequence. The text is returned and CommunicationService synthesizes it.
    this.handlers.set('TTS_SPEAK', async (step, _cycleCtx) => {
      const text = (step.params['text'] as string) ?? '';
      this.logger.debug(`TTS_SPEAK step ${step.index}: "${text.substring(0, 50)}..."`);
      // Return the text — CommunicationService handles actual synthesis
      // when it delivers the response via the delivery$ observable.
      return { text, ttsRequested: true };
    });

    // LOG_EVENT — logs the event payload via the NestJS logger. Fully functional.
    this.handlers.set('LOG_EVENT', async (step, _cycleCtx) => {
      this.logger.log(
        `LOG_EVENT (step ${step.index}): ${JSON.stringify(step.params)}`,
      );
      return { logged: true, timestamp: new Date().toISOString() };
    });

    this.logger.debug('Built-in action step handlers registered: LLM_GENERATE, WKG_QUERY, TTS_SPEAK, LOG_EVENT');
  }
}
