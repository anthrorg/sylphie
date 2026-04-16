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
import { ConfigService } from '@nestjs/config';
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

    private readonly config: ConfigService,
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

      // Build the system prompt — identity, drive state, person model.
      // No conversation history (causes the LLM to reference old exchanges).
      const drives = cycleCtx.cognitiveContext.driveSnapshot.pressureVector;
      const driveLines = Object.entries(drives)
        .filter(([, v]) => v > 0.2)
        .map(([name, v]) => `${name}: ${(v as number).toFixed(2)}`)
        .join(', ');

      const personModel = cycleCtx.frame.raw['person_model'] as
        { personId?: string; knownFacts?: string[]; interactionSummary?: string } | null | undefined;
      const personContext = personModel?.knownFacts?.length
        ? `About the person I'm talking to: ${personModel.knownFacts.join('; ')}`
        : '';

      const systemPrompt = [
        'You are Sylphie. Respond authentically and concisely.',
        instruction ? `Task: ${instruction}` : '',
        personContext,
        driveLines ? `How I feel: ${driveLines}` : '',
      ].filter(Boolean).join('\n\n');

      // Build messages: recent conversation turns + current input.
      // Conversation history is passed as normal multi-turn chat messages
      // (not injected into the system prompt, which caused re-referencing).
      const conversationHistory = cycleCtx.frame.raw['conversation_history'] as
        Array<{ role: 'user' | 'assistant'; content: string }> | undefined;

      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      if (conversationHistory && conversationHistory.length > 0) {
        // Keep only the last few turns to prevent context bloat.
        const recentTurns = conversationHistory.slice(-10);
        messages.push(...recentTurns);
      }
      const currentInput = inputText || instruction;
      if (currentInput) {
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
          tier: 'medium',
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

    // RESEARCH_ENTITY — autonomous entity research via web search + LLM extraction.
    // Relieves curiosity and boredom by looking up an entity from reputable
    // sources (wikipedia, dictionary, .edu), extracting structured knowledge
    // via LLM, and writing low-confidence nodes/edges to the WKG.
    this.handlers.set('RESEARCH_ENTITY', async (step, cycleCtx) => {
      // 1. Determine entity to research
      let entity = (step.params['entity'] as string) ?? '';
      if (!entity) {
        const rawText = cycleCtx.frame.raw['text'] as string | undefined;
        entity = rawText?.trim() || cycleCtx.inputSummary;
      }
      if (!entity) {
        this.logger.warn(`RESEARCH_ENTITY step ${step.index}: no entity to research.`);
        return null;
      }

      this.logger.log(`RESEARCH_ENTITY: Researching "${entity}"`);

      // 2. Query SearXNG for multiple reputable source types in parallel
      const searxngUrl = this.config.get<string>('ollama.searxngUrl', 'http://localhost:8888');
      const queries = [
        `"${entity}" site:wikipedia.org`,
        `"${entity}" definition dictionary`,
        `"${entity}" site:edu`,
      ];

      type SearchHit = { title: string; url: string; snippet: string; source: string };
      const searchResults: SearchHit[] = [];

      const searchPromises = queries.map(async (q): Promise<SearchHit[]> => {
        try {
          const url = `${searxngUrl}/search?q=${encodeURIComponent(q)}&format=json&language=en&categories=general,science&pageno=1`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10_000);
          const response = await fetch(url, {
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (!response.ok) return [];

          const data = (await response.json()) as {
            results?: Array<{ title?: string; url?: string; content?: string }>;
          };
          return (data.results ?? []).slice(0, 5).map((r) => ({
            title: r.title ?? '',
            url: r.url ?? '',
            snippet: r.content ?? '',
            source: classifySource(r.url ?? ''),
          }));
        } catch {
          return [];
        }
      });

      const allBatches = await Promise.all(searchPromises);
      for (const batch of allBatches) searchResults.push(...batch);

      // 3. Filter to reputable sources
      const reputable = searchResults.filter((r) =>
        /wikipedia\.org|\.edu|merriam-webster\.com|dictionary\.com|britannica\.com/.test(r.url),
      );
      const resultsToUse = reputable.length > 0 ? reputable : searchResults.slice(0, 5);

      if (resultsToUse.length === 0) {
        this.logger.warn(`RESEARCH_ENTITY: No search results for "${entity}".`);
        return { entity, results: 0, nodes: [], edges: [], note: 'No results found' };
      }

      // 4. Ask LLM to extract structured knowledge graph nodes and edges
      if (!this.llmService || !this.llmService.isAvailable()) {
        this.logger.warn('RESEARCH_ENTITY: LLM unavailable. Returning raw results only.');
        return { entity, results: resultsToUse.length, nodes: [], edges: [] };
      }

      const researchContext = resultsToUse
        .map((r, i) => `[${i + 1}] ${r.title}\n    Source: ${r.source} (${r.url})\n    ${r.snippet}`)
        .join('\n\n');

      const extractionPrompt = [
        `Extract structured knowledge about "${entity}" from the following web research.`,
        'Identify key facts, related entities, and relationships.',
        '',
        'RESEARCH RESULTS:',
        researchContext,
        '',
        'Respond with ONLY valid JSON in this exact format:',
        '{',
        '  "nodes": [{ "label": "EntityName", "type": "Concept|Person|Place|Thing|Event", "description": "brief description" }],',
        '  "edges": [{ "source": "EntityA", "target": "EntityB", "type": "RELATIONSHIP_TYPE" }]',
        '}',
        '',
        'Rules:',
        '- Include the main entity as a node',
        '- Include 3-8 related entities',
        '- Use UPPERCASE_SNAKE_CASE for relationship types (IS_TYPE_OF, HAS_PROPERTY, LOCATED_IN, PART_OF, CREATED_BY, etc.)',
        '- Only include facts clearly supported by the research results',
      ].join('\n');

      try {
        const response = await this.llmService.complete({
          messages: [{ role: 'user', content: extractionPrompt }],
          systemPrompt:
            'You are a knowledge graph extraction tool. Output ONLY valid JSON. No markdown, no explanation.',
          maxTokens: 512,
          temperature: 0.3,
          tier: 'medium',
          metadata: {
            callerSubsystem: 'LEARNING',
            purpose: 'RESEARCH_ENTITY_EXTRACTION',
            sessionId: cycleCtx.cognitiveContext.driveSnapshot.sessionId,
          },
        });

        // 5. Parse LLM response
        interface ExtractedNode { label: string; type: string; description?: string }
        interface ExtractedEdge { source: string; target: string; type: string }
        let parsed: { nodes?: ExtractedNode[]; edges?: ExtractedEdge[] } = {};
        try {
          const cleaned = response.content
            .replace(/```json?\s*/g, '')
            .replace(/```\s*/g, '')
            .trim();
          parsed = JSON.parse(cleaned);
        } catch {
          this.logger.warn('RESEARCH_ENTITY: Failed to parse LLM extraction response.');
          return { entity, results: resultsToUse.length, nodes: [], edges: [], parseError: true };
        }

        const nodes = parsed.nodes ?? [];
        const edges = parsed.edges ?? [];

        // 6. Write to WKG with low confidence (INFERENCE provenance → 0.30)
        //    These are web-sourced and unvalidated. A future "seek_factual_validation"
        //    action can elevate confidence after verification.
        const WEB_RESEARCH_CONFIDENCE = 0.30;
        const nodeIdMap = new Map<string, string>();

        if (this.wkgContext) {
          for (const node of nodes) {
            const nodeId = await this.wkgContext.writeEntity({
              label: node.label,
              nodeType: node.type || 'Concept',
              properties: {
                ...(node.description ? { description: node.description } : {}),
                source: 'web_research',
                research_entity: entity,
              },
              provenance: 'INFERENCE',
              confidence: WEB_RESEARCH_CONFIDENCE,
            });
            if (nodeId) nodeIdMap.set(node.label, nodeId);
          }

          for (const edge of edges) {
            const sourceId = nodeIdMap.get(edge.source);
            const targetId = nodeIdMap.get(edge.target);
            if (sourceId && targetId) {
              await this.wkgContext.writeRelationship({
                sourceId,
                targetId,
                type: edge.type || 'RELATED_TO',
                confidence: WEB_RESEARCH_CONFIDENCE,
                provenance: 'INFERENCE',
              });
            }
          }
        }

        this.logger.log(
          `RESEARCH_ENTITY: "${entity}" — ${nodes.length} nodes, ${edges.length} edges ` +
            `written to WKG (confidence: ${WEB_RESEARCH_CONFIDENCE})`,
        );

        return {
          entity,
          sourcesConsulted: resultsToUse.length,
          nodesCreated: nodes.length,
          edgesCreated: edges.length,
          confidence: WEB_RESEARCH_CONFIDENCE,
          nodes: nodes.map((n) => n.label),
          edges: edges.map((e) => `${e.source} -[${e.type}]-> ${e.target}`),
        };
      } catch (err) {
        this.logger.error(
          `RESEARCH_ENTITY failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    });

    this.logger.debug(
      'Built-in action step handlers registered: LLM_GENERATE, WKG_QUERY, TTS_SPEAK, LOG_EVENT, RESEARCH_ENTITY',
    );
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Classify a URL into a human-readable source category. */
function classifySource(url: string): string {
  if (!url) return 'unknown';
  try {
    const hostname = new URL(url).hostname;
    if (hostname.includes('wikipedia.org')) return 'encyclopedia';
    if (hostname.includes('britannica.com')) return 'encyclopedia';
    if (hostname.endsWith('.edu')) return 'academic';
    if (hostname.includes('merriam-webster.com') || hostname.includes('dictionary.com')) return 'dictionary';
    if (hostname.includes('arxiv.org') || hostname.includes('scholar.google')) return 'academic';
    return 'web';
  } catch {
    return 'web';
  }
}
