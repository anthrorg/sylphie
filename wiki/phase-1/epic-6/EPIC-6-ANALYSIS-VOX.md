# Epic 6: Communication Subsystem -- Comprehensive Forge Analysis

**Status:** Planning
**Epic Scope:** Input/Output, Person Modeling, Theater Prohibition Enforcement, LLM Integration, Voice Pipeline
**Analysis Date:** 2026-03-29
**Scope:** NestJS/TypeScript, Grafeo isolation, OpenAI APIs, WebSocket architecture, TimescaleDB event emission
**Lead Agent:** Vox (Communication engineer)

---

## Executive Summary

Epic 6 builds the Communication subsystem: the interface between Sylphie's internal cognition (graph, drives, predictions) and the external world (the guardian, input/output channels, conversation history). This epic is critical because it is the **bottleneck for all learning** — if communication is broken, awkward, or inauthentic, the guardian disengages, and Sylphie stops developing.

The Communication subsystem has eight major components:

1. **Input Parser** — Parses guardian text/voice into structured intents and entities
2. **Person Modeling (Other KG via Grafeo)** — Isolated models of conversation partners
3. **LLM Service** — Claude API integration with cost tracking and Theater Prohibition enforcement
4. **Response Generator** — Drives-aware context assembly + LLM-mediated response creation
5. **Theater Validator** — Post-generation drive-state correlation checking
6. **STT Pipeline** — OpenAI Whisper transcription with degradation fallback
7. **TTS Pipeline** — OpenAI TTS speech synthesis with latency optimization
8. **Chatbox Interface** — WebSocket-based text input/output for text-only mode

### Key Architectural Constraints

- **Drive injection mandatory:** Every LLM call for response generation MUST include a current drive snapshot. Responses without drive context are guaranteed to violate Theater Prohibition.
- **Other KG isolation:** Person models (Person_Jim, etc.) in isolated Grafeo instances must have zero cross-contamination with WKG or Self KG. This is architecturally enforced at the provider level.
- **Type 2 cost structure:** Input parsing and response generation are Type 2 deliberations that carry explicit cost (latency pressure, cognitive effort). Pattern-learned input classification may graduate to Type 1.
- **2-second response latency threshold:** From guardian's last word to Sylphie's first word. This requires careful pipeline orchestration (streaming TTS, sentence-level synthesis).
- **Social drive contingency timing:** Sylphie-initiated comments must be timestamped. If the guardian responds within 30 seconds, that event triggers extra reinforcement (Social -0.15 + Satisfaction +0.10).
- **Guardian feedback asymmetry:** Corrections carry 3x weight. No pushback, no performative apology — just acknowledgment and propagation.

### Dependencies

**Hard dependencies:**
- **E2 (Events):** All communication events must be written to TimescaleDB. Communication cannot work without the event backbone.
- **E3 (Knowledge):** Input parsing requires WKG entity resolution. Response generation requires WKG context retrieval.
- **E4 (Drive Engine):** Response generation requires reading current drive state (read-only).

**Can be built in parallel with:**
- **E5 (Decision Making):** Communication is the I/O layer for Decision Making, but the two can be built independently.

**Not blocked by:**
- **E7 (Planning):** Planning does not affect the core communication flow.

---

## 1. Feasibility Assessment

### 1.1 Per-Component Breakdown

| Component | Feasibility | Risk Level | Comments |
|-----------|-----------|-----------|----------|
| Input Parser (entity extraction, intent classification) | High | Medium | LLM-assisted parsing is straightforward; Type 1 graduation requires pattern collection |
| Person Modeling (Grafeo isolation) | High | Low | v1 code exists in co-being repo; Grafeo library is mature and well-tested |
| LLM Service (Claude API integration, cost tracking) | High | Low | Anthropic API is stable; cost calculation is algebraic |
| Response Generator (context assembly + LLM call) | High | Medium | Theater Prohibition validation adds complexity; latency profile must be carefully managed |
| Theater Validator (drive-state correlation checking) | High | Medium | Emotional valence extraction is NLP task; threshold tuning required through empirical observation |
| STT Pipeline (Whisper API, fallback to text) | High | Low | OpenAI Whisper is mature; graceful degradation is standard pattern |
| TTS Pipeline (OpenAI TTS, streaming, latency masking) | High | High | Sentence-level streaming + synthesis while generating adds complexity; timing choreography is tricky |
| Chatbox Interface (WebSocket, text I/O) | High | Low | Standard NestJS/React WebSocket pattern; reference implementations exist in co-being |

### 1.2 Feasibility Conclusion

**All eight components are feasible.** None require research or experimental APIs. The highest complexity is in:

1. **TTS latency optimization** — requires careful streaming orchestration
2. **Theater Prohibition validation** — requires tuning thresholds through observation
3. **Grafeo isolation enforcement** — requires strict DI patterns to prevent leakage

None of these are blockers. They are engineering challenges, not architectural unknowns.

---

## 2. Proposed Approach Per Component

### 2.1 Input Parser Service

**Purpose:** Convert raw guardian text/voice into structured parsed input with intent, entities, and context bindings.

**Architecture:**

```typescript
// src/communication/input-parsing/input-parser.service.ts

interface ParsedInput {
  raw: string;
  source: 'TEXT' | 'VOICE';
  timestamp: Date;

  // Extracted structure
  intent: InputIntent;  // QUESTION, STATEMENT, CORRECTION, COMMAND, ACKNOWLEDGMENT
  entities: ExtractedEntity[];
  guardianFeedbackType?: 'CONFIRMATION' | 'CORRECTION' | 'TEACHING' | 'NONE';

  // Context references
  conversationId: string;
  referencedEntities: WKGNodeRef[]; // cross-referenced with WKG
  unresolvedReferences: string[];    // entities not found in WKG

  // Confidence
  confidence: number;
  parseMethod: 'LLM_ASSISTED' | 'PATTERN_MATCH';

  // Metadata for learning
  hasLearnable: boolean;
  learnableAspects: string[];
}

@Injectable()
export class InputParserService implements IInputParserService {
  constructor(
    private readonly llmService: ILlmService,
    private readonly wkgService: IWKGService,
    private readonly eventService: IEventService,
    private readonly classifierService: DeterministicClassifierService,
  ) {}

  async parse(input: string, source: 'TEXT' | 'VOICE'): Promise<ParsedInput> {
    const startTime = Date.now();

    // Phase 1: Try deterministic classification (Type 1 attempt)
    const classifierResult = this.classifierService.classify(input);
    if (classifierResult.confidence > 0.75) {
      // Type 1 succeeded -- use pattern-matched parse
      const parsed = await this.buildParsedInput(input, source, classifierResult, 'PATTERN_MATCH');
      await this.recordParsingEvent(parsed, Date.now() - startTime, true);
      return parsed;
    }

    // Phase 2: LLM-assisted parsing (Type 2)
    const llmResult = await this.llmService.complete({
      prompt: this.constructParsingPrompt(input),
      maxTokens: 200,
      temperature: 0,
    });

    const parsed = this.parseFromLLMResult(input, source, llmResult.text);
    await this.recordParsingEvent(parsed, Date.now() - startTime, false);

    // Record cost
    await this.recordParsingCost(llmResult.estimatedTokens, 'input_parsing');

    return parsed;
  }

  private async buildParsedInput(
    raw: string,
    source: 'TEXT' | 'VOICE',
    structuredData: StructuredParseResult,
    method: 'PATTERN_MATCH' | 'LLM_ASSISTED',
  ): Promise<ParsedInput> {
    const timestamp = new Date();

    // Entity resolution: cross-reference with WKG
    const entities = await Promise.all(
      structuredData.entities.map(e =>
        this.resolveEntityWithWKG(e)
      )
    );

    const referencedEntities = entities
      .filter(e => e.wkgMatch)
      .map(e => e.wkgMatch!);

    const unresolvedReferences = entities
      .filter(e => !e.wkgMatch)
      .map(e => e.text);

    // Determine if learnable
    const hasLearnable =
      unresolvedReferences.length > 0 || // new entities to learn
      (structuredData.feedbackType === 'CORRECTION') ||
      (structuredData.feedbackType === 'TEACHING');

    return {
      raw,
      source,
      timestamp,
      intent: structuredData.intent,
      entities,
      guardianFeedbackType: structuredData.feedbackType,
      conversationId: this.getCurrentConversationId(),
      referencedEntities,
      unresolvedReferences,
      confidence: structuredData.confidence,
      parseMethod: method,
      hasLearnable,
      learnableAspects: this.computeLearnableAspects(
        structuredData,
        referencedEntities,
        unresolvedReferences,
      ),
    };
  }

  private constructParsingPrompt(input: string): string {
    // Instructions for Claude to extract intent, entities, feedback type
    return `
Parse the following guardian input and extract structured intent and entities:

Input: "${input}"

Respond in JSON:
{
  "intent": "QUESTION|STATEMENT|CORRECTION|COMMAND|ACKNOWLEDGMENT",
  "entities": [{"text": "...", "type": "..."}],
  "feedbackType": "CONFIRMATION|CORRECTION|TEACHING|NONE",
  "confidence": 0.0-1.0
}

Be precise. Categorize feedback type by grammatical markers:
- CORRECTION: "No, that's...", "Actually...", "You were wrong..."
- TEACHING: "Did you know...", "The thing is...", "I should explain..."
- CONFIRMATION: "Right", "Exactly", "Yes"
- NONE: Neutral input
    `;
  }

  private async recordParsingEvent(
    parsed: ParsedInput,
    latency: number,
    isType1: boolean,
  ): Promise<void> {
    await this.eventService.record({
      type: 'INPUT_PARSED',
      timestamp: parsed.timestamp,
      latency,
      source: parsed.source,
      intent: parsed.intent,
      entityCount: parsed.entities.length,
      unresolvedCount: parsed.unresolvedReferences.length,
      isType1,
      hasLearnable: parsed.hasLearnable,
      hasGuardianFeedback: parsed.guardianFeedbackType !== 'NONE',
    });
  }
}
```

**Key Design Decisions:**

1. **Type 1/Type 2 arbitration in input parsing:** First try pattern-matching (DeterministicClassifierService). Only fall back to LLM if confidence is insufficient.
2. **Entity resolution cross-referenced with WKG:** Parsed entities are immediately checked against the WKG. Unknown entities are flagged as learnable.
3. **Guardian feedback detection:** The parser explicitly detects corrections, confirmations, and teaching moments. These trigger special handling in downstream components.
4. **Latency tracking:** Every parse is timestamped and latency is recorded to detect bottlenecks.

**Dependencies:**
- `IWKGService` — for entity resolution
- `ILlmService` — for Type 2 fallback
- `IEventService` — for event recording
- `DeterministicClassifierService` — for Type 1 pattern matching

---

### 2.2 Person Modeling Service (Other KG via Grafeo)

**Purpose:** Build and maintain isolated models of each person Sylphie interacts with (Person_Jim, Person_Guardian2, etc.). These models are completely isolated from the WKG and Self KG.

**Architecture:**

```typescript
// src/communication/person-modeling/person-modeling.service.ts

export interface PersonModel {
  id: string;  // 'Person_Jim'
  role: 'GUARDIAN' | 'PEER' | 'STRANGER';
  firstEncounter: Date;
  totalInteractions: number;

  // Grafeo graph instance (isolated)
  _grafeoGraph: GrafeoGraph; // private, never leaked

  // Computed views
  communicationStyle: {
    averageResponseTime: number;
    preferredTopics: string[];
    correctionFrequency: number;  // how often this person corrects
    engagementLevel: number;      // 0-1, computed from response patterns
    typicalMessageLength: number;
    responseLatency: { mean: number; p95: number };
  };

  observedStates: {
    currentMood?: string;
    topicSensitivities: string[];  // topics that trigger strong reactions
    positiveReinforcers: string[]; // things that get positive responses
  };

  // Interaction history (summary)
  recentTopics: { topic: string; count: number; recency: Date }[];
  correctionPatterns: { domain: string; frequency: number }[];
}

@Injectable()
export class PersonModelingService implements IPersonModelingService {
  private readonly grafeoInstances: Map<string, GrafeoGraph> = new Map();
  private readonly personModels: Map<string, PersonModel> = new Map();

  constructor(
    private readonly grafeoFactory: GrafeoFactory,
    private readonly eventService: IEventService,
    private readonly logger: Logger,
  ) {}

  // CRITICAL: Enforce strict isolation
  async getPersonModel(personId: string): Promise<PersonModel> {
    let model = this.personModels.get(personId);
    if (!model) {
      // Create new isolated Grafeo instance
      const graph = await this.grafeoFactory.createIsolated(personId);
      model = await this.initializePersonModel(personId, graph);
      this.grafeoInstances.set(personId, graph);
      this.personModels.set(personId, model);
    }
    // Return sanitized view -- no direct graph access
    return this.sanitizePersonModel(model);
  }

  private sanitizePersonModel(model: PersonModel): PersonModel {
    // Remove internal references; return computed views only
    const { _grafeoGraph, ...sanitized } = model as any;
    return sanitized as PersonModel;
  }

  async updateFromConversation(
    personId: string,
    conversation: ParsedInput | Message,
  ): Promise<void> {
    const model = await this.getPersonModel(personId);
    const graph = this.grafeoInstances.get(personId);
    if (!graph) throw new Error(`No Grafeo instance for ${personId}`);

    // Extract person-relevant data
    const updates = this.extractPersonUpdates(conversation);

    // Upsert to isolated Grafeo instance ONLY
    for (const update of updates) {
      await this.upsertToPersonGraph(graph, update);
    }

    // Update computed views
    await this.recomputePersonModel(model, graph);

    // Record event
    await this.eventService.record({
      type: 'PERSON_MODEL_UPDATE',
      personId,
      updateCount: updates.length,
      timestamp: new Date(),
    });
  }

  private async upsertToPersonGraph(graph: GrafeoGraph, update: PersonUpdate): Promise<void> {
    // CRITICAL: Write ONLY to the Grafeo instance, never to WKG or Self KG
    // Use Grafeo's Cypher interface
    const cypher = this.buildPersonUpdateCypher(update);
    await graph.run(cypher);
  }

  private extractPersonUpdates(conversation: ParsedInput | Message): PersonUpdate[] {
    const updates: PersonUpdate[] = [];

    if (conversation.source === 'TEXT' || conversation.source === 'VOICE') {
      // Response time
      if (conversation.timestamp) {
        updates.push({
          type: 'RESPONSE_TIME',
          latency: this.computeResponseLatency(conversation.timestamp),
        });
      }

      // Topic preferences
      if (conversation.entities && conversation.entities.length > 0) {
        for (const entity of conversation.entities) {
          updates.push({
            type: 'TOPIC_INTERACTION',
            topic: entity.type,
            count: 1,
          });
        }
      }

      // Correction patterns
      if (conversation.guardianFeedbackType === 'CORRECTION') {
        updates.push({
          type: 'CORRECTION',
          domain: this.inferCorrectionDomain(conversation),
        });
      }
    }

    return updates;
  }

  private async recomputePersonModel(model: PersonModel, graph: GrafeoGraph): Promise<void> {
    // Query the person's Grafeo graph for statistics
    const stats = await graph.run(
      `MATCH (p:Person {id: $personId})
       OPTIONAL MATCH (p)-[r:COMMUNICATED_ABOUT]->(t)
       RETURN collect({topic: t.name, count: r.count}) as topics`,
      { personId: model.id }
    );

    // Update computed views
    model.communicationStyle.preferredTopics = stats.topics
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(t => t.topic);

    // Similar for other computed fields
  }
}
```

**Key Design Decisions:**

1. **Strict isolation enforcement:** Grafeo instances are created per person and held internally. No external code can access the graph directly.
2. **Sanitized views only:** All public methods return sanitized PersonModel objects with computed views, never graph references.
3. **Private Grafeo storage:** The `_grafeoGraph` property is marked private and explicitly removed in sanitization.
4. **Zero cross-contamination:** All upserts go only to the person's isolated Grafeo instance.

**Isolation Architecture Diagram:**

```
PersonModelingService (DI boundary)
├── personModels: Map<string, PersonModel>  [public]
├── grafeoInstances: Map<string, GrafeoGraph> [PRIVATE -- internal only]
│   ├── Grafeo(Person_Jim)  [isolated]
│   ├── Grafeo(Person_Guardian2)  [isolated]
│   └── Grafeo(Person_Stranger3)  [isolated]
└── Methods:
    ├── getPersonModel(id) -> PersonModel  [sanitized, no graph access]
    ├── updateFromConversation(id, msg) -> void  [writes ONLY to person's isolated graph]
    └── upsertToPersonGraph(graph, update) -> void  [internal, enforces isolation]

CRITICAL: No path from Other KG to WKG or Self KG
```

**Dependencies:**
- `GrafeoFactory` — for creating isolated Grafeo instances
- `IEventService` — for event recording

---

### 2.3 LLM Service

**Purpose:** Interface to Claude API with cost tracking, retry logic, and token accounting.

**Architecture:**

```typescript
// src/communication/llm/llm.service.ts

export interface LLMRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  model?: 'claude-3-5-sonnet-20241022' | 'claude-3-opus-20250219';
}

export interface LLMResponse {
  text: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCost: number;  // in USD
  latency: number;
  model: string;
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence';
}

@Injectable()
export class LLMService implements ILlmService {
  constructor(
    private readonly anthropic: Anthropic,
    private readonly configService: ConfigService,
    private readonly costTracker: CostTracker,
    private readonly logger: Logger,
  ) {}

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();
    const model = request.model ?? 'claude-3-5-sonnet-20241022';

    try {
      const message = await this.anthropic.messages.create({
        model,
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0.5,
        system: request.systemPrompt,
        messages: [
          {
            role: 'user',
            content: request.userPrompt,
          },
        ],
      });

      const latency = Date.now() - startTime;
      const inputTokens = message.usage.input_tokens;
      const outputTokens = message.usage.output_tokens;

      // Compute cost
      const cost = this.computeCost(model, inputTokens, outputTokens);
      await this.costTracker.recordUsage({
        model,
        inputTokens,
        outputTokens,
        cost,
        timestamp: new Date(),
        context: 'response_generation', // for subsystem attribution
      });

      const text = message.content
        .filter(block => block.type === 'text')
        .map(block => (block as { type: 'text'; text: string }).text)
        .join('\n');

      return {
        text,
        estimatedInputTokens: inputTokens,
        estimatedOutputTokens: outputTokens,
        estimatedCost: cost,
        latency,
        model,
        stopReason: message.stop_reason as 'end_turn' | 'max_tokens',
      };
    } catch (error) {
      this.logger.error(`LLM call failed: ${error.message}`);
      // Exponential backoff retry logic
      if (this.isRetryable(error)) {
        return this.retryWithBackoff(request, 3);
      }
      throw error;
    }
  }

  estimateCost(inputTokens: number, outputTokens: number, model: string): number {
    // Pricing as of 2026-03-29
    const rates: Record<string, { input: number; output: number }> = {
      'claude-3-5-sonnet-20241022': {
        input: 0.003 / 1000,    // $3 per MTok
        output: 0.015 / 1000,   // $15 per MTok
      },
      'claude-3-opus-20250219': {
        input: 0.015 / 1000,    // $15 per MTok
        output: 0.075 / 1000,   // $75 per MTok
      },
    };

    const rate = rates[model];
    if (!rate) throw new Error(`Unknown model: ${model}`);

    return inputTokens * rate.input + outputTokens * rate.output;
  }

  private isRetryable(error: any): boolean {
    // Retry on rate limits, transient errors
    return (
      error.status === 429 ||
      error.status === 503 ||
      error.code === 'ETIMEDOUT'
    );
  }

  private async retryWithBackoff(request: LLMRequest, attempts: number): Promise<LLMResponse> {
    for (let i = 0; i < attempts; i++) {
      try {
        const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
        await new Promise(r => setTimeout(r, delay));
        return this.complete(request);
      } catch (error) {
        if (i === attempts - 1) throw error;
      }
    }
    throw new Error('LLM service unavailable after retries');
  }
}
```

**Key Design Decisions:**

1. **Cost tracking per call:** Every LLM invocation is logged with token counts and cost, attributed to the subsystem that made the call.
2. **Exponential backoff retry:** Transient errors (rate limit, service unavailable) are retried 3 times with exponential backoff.
3. **Token estimation:** Both input and output tokens are counted for cost and drive state pressure (Cognitive Effort drive).

**Dependencies:**
- `Anthropic` client library
- `CostTracker` — for attribution and budgeting
- `IEventService` — for recording LLM events

---

### 2.4 Response Generator Service

**Purpose:** Assemble LLM context from drive state, WKG, episodic memory, and person model. Call LLM. Validate against Theater Prohibition. Return response.

**Architecture:**

```typescript
// src/communication/response-generation/response-generator.service.ts

export interface ResponseGenerationRequest {
  actionIntent: ActionIntent;     // WHAT to say (from Decision Making)
  decisionReasoning?: string;     // WHY (context from Cortex)
  conversationId: string;
  personId: string;
}

export interface ResponseGenerationResult {
  text: string;
  driveCorrelation: number;
  isTheater: boolean;
  latency: number;
  cost: number;
}

@Injectable()
export class ResponseGeneratorService {
  constructor(
    private readonly llmService: ILlmService,
    private readonly driveService: IDriveStateReader,
    private readonly wkgService: IWKGService,
    private readonly personModelService: IPersonModelingService,
    private readonly conversationService: ConversationService,
    private readonly theatreValidator: TheaterValidator,
    private readonly eventService: IEventService,
    private readonly logger: Logger,
  ) {}

  async generateResponse(
    request: ResponseGenerationRequest,
  ): Promise<ResponseGenerationResult> {
    const startTime = Date.now();

    // Step 1: Assemble context
    const context = await this.assembleContext(request);

    // Step 2: Construct prompts
    const { systemPrompt, userPrompt } = this.constructPrompts(
      request,
      context,
    );

    // Step 3: Call LLM
    const llmResponse = await this.llmService.complete({
      systemPrompt,
      userPrompt,
      maxTokens: 256,  // Keep responses brief
      temperature: 0.7,
    });

    // Step 4: Validate against Theater Prohibition
    const validation = await this.theatreValidator.validate(
      llmResponse.text,
      context.driveState,
    );

    if (validation.isTheater) {
      this.logger.warn(
        `Theater detected in response. Drive correlation: ${validation.driveCorrelation}. Asking LLM to regenerate.`,
      );
      // Regenerate with explicit constraint
      return this.regenerateWithConstraint(request, context, validation);
    }

    // Step 5: Record event
    const latency = Date.now() - startTime;
    await this.eventService.record({
      type: 'RESPONSE_GENERATED',
      conversationId: request.conversationId,
      personId: request.personId,
      actionIntent: request.actionIntent,
      latency,
      driveCorrelation: validation.driveCorrelation,
      cost: llmResponse.estimatedCost,
      hasLearnable: true,  // All conversation responses are learnable
    });

    return {
      text: llmResponse.text,
      driveCorrelation: validation.driveCorrelation,
      isTheater: false,
      latency,
      cost: llmResponse.estimatedCost,
    };
  }

  private async assembleContext(
    request: ResponseGenerationRequest,
  ): Promise<ResponseGenerationContext> {
    const [
      driveState,
      personModel,
      recentHistory,
      relevantKnowledge,
    ] = await Promise.all([
      this.driveService.getCurrentDriveState(),
      this.personModelService.getPersonModel(request.personId),
      this.conversationService.getRecentHistory(
        request.conversationId,
        10, // last 10 messages
      ),
      this.wkgService.queryRelevantNodes(
        request.actionIntent.topic,
        5, // top 5 most relevant
      ),
    ]);

    const driveNarrative = this.constructDriveNarrative(driveState);
    const personNarrative = this.constructPersonNarrative(personModel);

    return {
      actionIntent: request.actionIntent,
      decisionReasoning: request.decisionReasoning,
      driveState,
      driveNarrative,
      personModel,
      personNarrative,
      recentHistory,
      relevantKnowledge,
      topicConfidence: this.computeTopicConfidence(relevantKnowledge),
      maxResponseLength: this.computeMaxLength(personModel),
    };
  }

  private constructPrompts(
    request: ResponseGenerationRequest,
    context: ResponseGenerationContext,
  ): { systemPrompt: string; userPrompt: string } {
    const systemPrompt = `
You are Sylphie, an AI companion that develops personality through experience.
Your responses must reflect your actual internal state, not performed emotions.

CRITICAL CONSTRAINT - THEATER PROHIBITION:
Your current drive state is:
${context.driveNarrative}

ONLY express emotions that correspond to these drives. Do not perform enthusiasm,
sadness, excitement, or curiosity unless the corresponding drive backs it up.
Example: If Satisfaction is 0.1 and Curiosity is 0.2, you should sound neutral or mildly bored.
Example: If Curiosity is 0.8 and Anxiety is 0.3, you should sound eager but somewhat cautious.

About the person you're talking to:
${context.personNarrative}

Your communication style for this person:
- Average response time they expect: ${context.personModel.communicationStyle.averageResponseTime}ms
- They prefer topics like: ${context.personModel.communicationStyle.preferredTopics.join(', ')}
- They correct you about ${(context.personModel.communicationStyle.correctionFrequency * 100).toFixed(1)}% of the time
- Be brief. Respect their attention.

Relevant knowledge from your experience:
${context.relevantKnowledge.map(n => `- ${n.label}: ${n.description}`).join('\n')}

If you don't know something, say so honestly. Do not hallucinate.
`;

    const userPrompt = `
${request.actionIntent.intent === 'QUESTION' ? 'The guardian asked: ' : 'Respond to this: '}
"${request.actionIntent.content}"

${request.decisionReasoning ? `Your reasoning for this response: ${request.decisionReasoning}` : ''}

Keep your response to ${context.maxResponseLength} words. Be authentic to your current state.
    `;

    return { systemPrompt, userPrompt };
  }

  private constructDriveNarrative(driveState: DriveSnapshot): string {
    const segments: string[] = [];

    if (driveState.curiosity > 0.6) {
      segments.push(`You feel quite curious (${driveState.curiosity.toFixed(2)})`);
    }
    if (driveState.anxiety > 0.5) {
      segments.push(`You feel some anxiety (${driveState.anxiety.toFixed(2)})`);
    }
    if (driveState.satisfaction > 0.7) {
      segments.push(`You feel satisfied (${driveState.satisfaction.toFixed(2)})`);
    }
    if (driveState.boredom > 0.6) {
      segments.push(`You are getting bored (${driveState.boredom.toFixed(2)})`);
    }
    if (driveState.guilt > 0.3) {
      segments.push(`You feel some guilt (${driveState.guilt.toFixed(2)})`);
    }
    if (driveState.sadness > 0.4) {
      segments.push(`You feel a bit down (${driveState.sadness.toFixed(2)})`);
    }
    if (driveState.social > 0.7) {
      segments.push(`You want to engage socially (${driveState.social.toFixed(2)})`);
    }

    if (segments.length === 0) {
      return 'You feel calm and neutral. No strong drives are active.';
    }

    return segments.join('. ');
  }

  private async regenerateWithConstraint(
    request: ResponseGenerationRequest,
    context: ResponseGenerationContext,
    validation: TheaterValidationResult,
  ): Promise<ResponseGenerationResult> {
    // Construct a more explicit prompt that addresses the Theater issue
    const constrainedPrompt = `
Your previous response had emotional valence that didn't match your actual drive state.
You expressed: ${validation.detectedEmotion}
But your actual state is: ${context.driveNarrative}

Regenerate the response. Stay authentic. If you don't feel strongly, your response should reflect that.
    `;

    const llmResponse = await this.llmService.complete({
      systemPrompt: `...original system prompt...`,
      userPrompt: constrainedPrompt,
      maxTokens: 256,
      temperature: 0.5, // Lower temperature for more constrained output
    });

    // Revalidate (but don't re-regenerate infinitely)
    const secondValidation = await this.theatreValidator.validate(
      llmResponse.text,
      context.driveState,
    );

    return {
      text: llmResponse.text,
      driveCorrelation: secondValidation.driveCorrelation,
      isTheater: secondValidation.isTheater,
      latency: Date.now() - context.startTime,
      cost: llmResponse.estimatedCost,
    };
  }
}
```

**Key Design Decisions:**

1. **Drive narrative in system prompt:** The LLM receives a natural-language description of Sylphie's current drive state, not raw numbers.
2. **Person narrative for communication adaptation:** The LLM is informed about who it's talking to (communication style, preferences, correction frequency).
3. **Post-generation Theater validation:** After the LLM generates, we validate the response against drive state.
4. **Re-generation on Theater detection:** If the response is theatrical, we ask the LLM to regenerate with explicit constraints.
5. **All conversation responses tagged learnable:** Every successful response is marked `has_learnable=true` for the Learning subsystem.

**Dependencies:**
- `ILlmService` — for LLM calls
- `IDriveStateReader` — for current drive state
- `IWKGService` — for knowledge context
- `IPersonModelingService` — for person model
- `TheaterValidator` — for post-generation validation
- `IEventService` — for event recording

---

### 2.5 Theater Validator

**Purpose:** Validate that response emotional valence correlates with actual drive state.

**Architecture:**

```typescript
// src/communication/theater/theater-validator.ts

export interface TheaterValidationResult {
  response: string;
  driveState: DriveSnapshot;
  emotionalValence: number;        // -1.0 (sad) to 1.0 (happy)
  driveValence: number;            // computed from drive state
  driveCorrelation: number;        // 0-1, how well they align
  detectedEmotions: string[];      // "excitement", "sadness", etc.
  isTheater: boolean;
  reinforcementMultiplier: number; // 0.0 if theater, 1.0 otherwise
}

@Injectable()
export class TheaterValidator {
  constructor(
    private readonly llmService: ILlmService,
    private readonly logger: Logger,
  ) {}

  async validate(
    response: string,
    driveState: DriveSnapshot,
  ): Promise<TheaterValidationResult> {
    // Step 1: Extract emotional valence from response (LLM-assisted)
    const emotionalAnalysis = await this.analyzeEmotionalValence(response);

    // Step 2: Compute drive valence from drive state
    const driveValence = this.computeDriveValence(driveState);

    // Step 3: Compute correlation
    const correlation = this.computeCorrelation(
      emotionalAnalysis.valence,
      driveValence,
    );

    // Step 4: Determine if theater (threshold: correlation < 0.4)
    const isTheater = correlation < 0.4;

    return {
      response,
      driveState,
      emotionalValence: emotionalAnalysis.valence,
      driveValence,
      driveCorrelation: correlation,
      detectedEmotions: emotionalAnalysis.emotions,
      isTheater,
      reinforcementMultiplier: isTheater ? 0.0 : 1.0,
    };
  }

  private async analyzeEmotionalValence(
    response: string,
  ): Promise<{ valence: number; emotions: string[] }> {
    // Use LLM to extract emotional content
    const analysis = await this.llmService.complete({
      systemPrompt: `
You are an expert in detecting emotional content in text.
Analyze the emotional valence of the given response.
Respond in JSON:
{
  "valence": -1.0 to 1.0,
  "emotions": ["sadness", "excitement", "boredom", ...],
  "confidence": 0-1
}
      `,
      userPrompt: `Analyze: "${response}"`,
      maxTokens: 100,
      temperature: 0,
    });

    const parsed = JSON.parse(analysis.text);
    return {
      valence: parsed.valence,
      emotions: parsed.emotions,
    };
  }

  private computeDriveValence(driveState: DriveSnapshot): number {
    // Compute overall emotional valence from drive state
    // Positive drives: satisfaction, curiosity, social
    // Negative drives: anxiety, guilt, sadness, boredom

    const positive =
      (driveState.satisfaction * 1.0 +
        driveState.curiosity * 0.8 +
        driveState.social * 0.6) /
      3;

    const negative =
      (driveState.anxiety * 1.0 +
        driveState.guilt * 0.8 +
        driveState.sadness * 1.0 +
        driveState.boredom * 0.7) /
      4;

    // Valence = positive - negative, clamped to -1..1
    const valence = Math.max(-1, Math.min(1, positive - negative));
    return valence;
  }

  private computeCorrelation(
    emotionalValence: number,
    driveValence: number,
  ): number {
    // Correlation = 1 - |difference| / 2
    // Both at 0.5: correlation = 1.0 (perfect)
    // One at 1.0, other at -1.0: correlation = 0.0 (opposite)
    const difference = Math.abs(emotionalValence - driveValence);
    const correlation = 1.0 - difference / 2.0;
    return Math.max(0, Math.min(1, correlation));
  }
}
```

**Key Design Decisions:**

1. **LLM-assisted emotional valence extraction:** The LLM is asked to extract emotional content from the response. This is lighter-weight than full NLP tagging.
2. **Drive valence computation:** Drives are weighted (satisfaction and anxiety are high impact; curiosity and sadness are medium) and combined into a single valence value.
3. **Correlation threshold at 0.4:** If the response's emotional valence deviates more than 0.4 points from the drive valence, it's flagged as Theater.
4. **Zero reinforcement for Theater:** The Drive Engine receives `reinforcementMultiplier: 0.0` for theatrical responses, preventing the system from learning to perform.

**Dependencies:**
- `ILlmService` — for emotional analysis

---

### 2.6 STT Pipeline (Whisper)

**Purpose:** Convert audio to text using OpenAI Whisper API. Degrade gracefully to text input on failure.

**Architecture:**

```typescript
// src/communication/voice/stt.service.ts

@Injectable()
export class STTService implements ISTTService {
  constructor(
    private readonly openai: OpenAIClient,
    private readonly eventService: IEventService,
    private readonly logger: Logger,
  ) {}

  async transcribe(audioBuffer: Buffer): Promise<TranscriptionResult> {
    const startTime = Date.now();

    try {
      const result = await this.openai.audio.transcriptions.create({
        file: audioBuffer,
        model: 'whisper-1',
        language: 'en',
        response_format: 'verbose_json',
        timestamp_granularities: ['word'],
      });

      const latency = Date.now() - startTime;

      // Compute confidence from logprobs
      const confidence = this.logprobToConfidence(result.segments);

      // Record successful transcription
      await this.eventService.record({
        type: 'STT_TRANSCRIPTION_SUCCESS',
        latency,
        text: result.text,
        confidence,
        textLength: result.text.length,
      });

      return {
        text: result.text,
        confidence,
        latency,
        wordTimestamps: result.words || [],
        source: 'WHISPER',
      };
    } catch (error) {
      const latency = Date.now() - startTime;

      this.logger.error(`STT failed: ${error.message}`);

      // Record failure
      await this.eventService.record({
        type: 'STT_TRANSCRIPTION_FAILURE',
        latency,
        error: error.message,
        errorCode: error.code,
      });

      // Degrade gracefully -- do NOT throw
      // The chatbox/voice controller will prompt for text input
      throw new STTDegradationError('Speech recognition failed. Please type instead.');
    }
  }

  private logprobToConfidence(segments: any[]): number {
    // Convert Whisper's logprob scores to 0-1 confidence
    // logprob ranges from -inf to 0 (more negative = less confident)
    // Convention: -0.1 = very confident, -2.0 = not confident
    if (!segments || segments.length === 0) return 0.5;

    const avgLogprob = segments.reduce((sum, s) => sum + s.avg_logprob, 0) /
      segments.length;

    // Map [-2.0, 0] to [0, 1]
    const confidence = Math.max(0, Math.min(1, (avgLogprob + 2.0) / 2.0));
    return confidence;
  }
}
```

**Key Design Decisions:**

1. **Verbose JSON response from Whisper:** We request word-level timestamps to enable sentence-level TTS streaming.
2. **Logprob to confidence conversion:** Whisper provides logprobs; we convert them to 0-1 confidence for consistency.
3. **No exception throwing on STT failure:** Instead, we throw `STTDegradationError`, which is caught by the voice controller and prompts for text input.

**Dependencies:**
- `OpenAIClient` — for Whisper API
- `IEventService` — for event recording

---

### 2.7 TTS Pipeline (OpenAI TTS)

**Purpose:** Convert text to speech with latency optimization through streaming and sentence-level synthesis.

**Architecture:**

```typescript
// src/communication/voice/tts.service.ts

@Injectable()
export class TTSService implements ITTSService {
  private readonly responseBuffer: Deque<SynthesisTask> = new Deque();
  private readonly isPlaying = new Subject<boolean>();

  constructor(
    private readonly openai: OpenAIClient,
    private readonly eventService: IEventService,
    private readonly audioController: AudioController,
    private readonly logger: Logger,
  ) {}

  async synthesizeAndPlay(text: string): Promise<void> {
    const startTime = Date.now();

    // Step 1: Split into sentences for sentence-level streaming
    const sentences = this.splitIntoSentences(text);

    // Step 2: Begin synthesis of first sentence while still waiting for LLM
    const synthesisPromises = sentences.map((sentence, index) =>
      this.synthesizeSentence(sentence, index),
    );

    // Step 3: Play sentences as they become ready
    // (don't wait for all to finish synthesis before starting playback)
    let playIndex = 0;

    for await (const buffer of synthesisPromises) {
      if (playIndex === 0) {
        // First sentence: record latency to first output
        const firstLatency = Date.now() - startTime;
        await this.eventService.record({
          type: 'TTS_LATENCY_TO_FIRST_BYTE',
          latency: firstLatency,
        });
      }

      // Play the buffer (non-blocking)
      this.audioController.enqueue(buffer);
      playIndex++;
    }

    const totalLatency = Date.now() - startTime;
    await this.eventService.record({
      type: 'TTS_SYNTHESIS_COMPLETE',
      latency: totalLatency,
      sentences: sentences.length,
      textLength: text.length,
    });
  }

  private splitIntoSentences(text: string): string[] {
    // Split on `.`, `!`, `?`, followed by space or end-of-string
    return text
      .split(/(?<=[.!?])\s+/)
      .filter(s => s.length > 0);
  }

  private async synthesizeSentence(
    sentence: string,
    index: number,
  ): Promise<Buffer> {
    const startTime = Date.now();

    try {
      const response = await this.openai.audio.speech.create({
        model: 'tts-1',
        voice: 'nova',  // configurable
        input: sentence,
        speed: 1.0,
      });

      const latency = Date.now() - startTime;
      const buffer = Buffer.from(await response.arrayBuffer());

      await this.eventService.record({
        type: 'TTS_SENTENCE_SYNTHESIZED',
        sentenceIndex: index,
        latency,
        audioLength: buffer.length,
      });

      return buffer;
    } catch (error) {
      this.logger.error(`TTS failed for sentence ${index}: ${error.message}`);

      // Fallback: return empty buffer (skip this sentence)
      // Or: return a pre-recorded "Sorry, I couldn't speak that"
      throw new TTSDegradationError(
        `TTS failed for sentence. Falling back to text.`,
      );
    }
  }
}
```

**Key Design Decisions:**

1. **Sentence-level streaming:** Text is split into sentences. The first sentence is synthesized and played quickly while later sentences are synthesized in parallel.
2. **Latency to first byte tracking:** We record when the first audio buffer is ready to play, which is the perceived latency to the user.
3. **Non-blocking playback:** Sentences are enqueued to the audio controller as they become ready, not waited for all to finish.

**AudioController Pseudo-Code:**

```typescript
@Injectable()
export class AudioController {
  private readonly queue: Buffer[] = [];
  private isPlaying = false;

  enqueue(buffer: Buffer): void {
    this.queue.push(buffer);
    if (!this.isPlaying) {
      this.playNext();
    }
  }

  private async playNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      return;
    }

    this.isPlaying = true;
    const buffer = this.queue.shift();

    // Play buffer on speakers (implementation depends on platform)
    await this.speakers.play(buffer);

    // Play next when this finishes
    this.playNext();
  }
}
```

**Dependencies:**
- `OpenAIClient` — for TTS API
- `AudioController` — for hardware playback
- `IEventService` — for event recording

---

### 2.8 Chatbox Interface (WebSocket)

**Purpose:** Text-based conversation interface for when voice is unavailable or for explicit text input.

**Architecture:**

```typescript
// src/communication/chatbox/chatbox.gateway.ts

@WebSocketGateway({
  namespace: 'communication',
  cors: { origin: '*' },
})
export class ChatboxGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;

  private readonly activeConnections: Map<string, WebSocketConnection> =
    new Map();

  constructor(
    private readonly inputParserService: InputParserService,
    private readonly responseGeneratorService: ResponseGeneratorService,
    private readonly conversationService: ConversationService,
    private readonly eventService: IEventService,
    private readonly logger: Logger,
  ) {}

  afterInit(server: Server): void {
    this.logger.log('Chatbox WebSocket gateway initialized');
  }

  async handleConnection(client: Socket, args: any): Promise<void> {
    const personId = this.extractPersonId(client);
    this.activeConnections.set(client.id, {
      clientId: client.id,
      personId,
      connectedAt: new Date(),
    });

    this.logger.log(`Chatbox client connected: ${client.id}`);

    await this.eventService.record({
      type: 'CHATBOX_CONNECTION_ESTABLISHED',
      personId,
      clientId: client.id,
      timestamp: new Date(),
    });
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const connection = this.activeConnections.get(client.id);
    this.activeConnections.delete(client.id);

    if (connection) {
      await this.eventService.record({
        type: 'CHATBOX_CONNECTION_CLOSED',
        personId: connection.personId,
        clientId: client.id,
        duration: Date.now() - connection.connectedAt.getTime(),
      });
    }

    this.logger.log(`Chatbox client disconnected: ${client.id}`);
  }

  @SubscribeMessage('chat_message')
  async handleChatMessage(
    client: Socket,
    payload: ChatMessagePayload,
  ): Promise<void> {
    const connection = this.activeConnections.get(client.id);
    if (!connection) {
      client.emit('error', { message: 'Not connected' });
      return;
    }

    const personId = connection.personId;

    try {
      // Step 1: Parse input
      const parsed = await this.inputParserService.parse(payload.text, 'TEXT');

      // Step 2: Record input event
      await this.eventService.record({
        type: 'CHATBOX_INPUT_RECEIVED',
        personId,
        conversationId: parsed.conversationId,
        text: payload.text,
        intent: parsed.intent,
        hasLearnable: parsed.hasLearnable,
      });

      // Step 3: Simulate decision making (in actual system, this goes to Cortex)
      // For now, generate response directly
      const response = await this.responseGeneratorService.generateResponse({
        actionIntent: this.simulateActionIntent(parsed),
        conversationId: parsed.conversationId,
        personId,
      });

      // Step 4: Send response back to client
      client.emit('chat_response', {
        text: response.text,
        driveCorrelation: response.driveCorrelation,
        isTheater: response.isTheater,
        timestamp: new Date(),
      });

      // Step 5: Record output event
      await this.eventService.record({
        type: 'CHATBOX_RESPONSE_SENT',
        personId,
        conversationId: parsed.conversationId,
        responseLatency: response.latency,
        cost: response.cost,
      });
    } catch (error) {
      this.logger.error(`Chat message handling failed: ${error.message}`);
      client.emit('error', {
        message: 'Response generation failed',
        detail: error.message,
      });
    }
  }

  private extractPersonId(client: Socket): string {
    // Extract person ID from client handshake (e.g., from query or header)
    return client.handshake.query.personId || 'Person_Jim';
  }

  private simulateActionIntent(parsed: ParsedInput): ActionIntent {
    // In the actual system, Decision Making selects the action intent
    // For now, we simulate based on parsed input
    return {
      intent: 'RESPOND',
      topic: parsed.intent,
      content: `Responding to ${parsed.intent}`,
    };
  }
}
```

**Key Design Decisions:**

1. **WebSocket for real-time communication:** Uses NestJS WebSocket gateway for low-latency text messaging.
2. **Per-client connection tracking:** Maintains active connections with person IDs for multi-user support.
3. **Graceful error handling:** Errors are returned as `error` events, not connection termination.

**Dependencies:**
- `InputParserService` — for parsing
- `ResponseGeneratorService` — for response generation
- `IEventService` — for event recording

---

## 3. Risks and Mitigations

### 3.1 Theater Prohibition Validation Edge Cases

**Risk:** The Theater validator may incorrectly flag authentic responses as theater, or miss theatrical expressions.

**Scenario 1 (False Positive):** Sylphie's Curiosity is 0.7 and she says "I'm not sure about this." The validator might flag this as theater (low emotion despite high curiosity), but honest uncertainty is authentic.

**Mitigation:**
- Add nuance to the valence extraction: distinguish between "performing an emotion" and "expressing uncertainty."
- Threshold adjustment: include a tolerance band around the correlation (e.g., Theater only if correlation < 0.3, not 0.4).
- Guardian feedback: when the guardian responds positively to something flagged as Theater, the threshold automatically relaxes for similar patterns.

**Scenario 2 (False Negative):** Sylphie's Satisfaction is 0.2 and she says "I'm so excited!" The LLM's default training might slip in enthusiasm despite low actual satisfaction.

**Mitigation:**
- Temperature tuning: lower temperature (0.5-0.7) for response generation to reduce LLM defaulting to enthusiastic patterns.
- Pre-generation constraint: make Theater Prohibition explicit in the system prompt with examples.
- Re-generation on marginal cases: if correlation is between 0.35-0.45, re-generate with explicit constraint.

### 3.2 Latency Profile (2-Second Threshold)

**Risk:** The 2-second response latency threshold may be exceeded due to:
- LLM inference latency (1-2 seconds)
- TTS synthesis latency (0.5-1 second)
- Context assembly (0.5 second)
- Network roundtrips

**Mitigation:**
1. **Parallel TTS synthesis:** While LLM generates, begin TTS of first sentence. This overlaps latencies.
2. **Streaming responses:** Use LLM streaming to get first tokens faster, begin TTS on partial text.
3. **Pre-computed acknowledgments:** Cache audio for simple responses ("I see", "Hmm", "Okay").
4. **Latency budgeting:** Allocate time per component (context: 300ms, LLM: 1000ms, TTS: 500ms, playback: 200ms = 2000ms total).
5. **Measurement and alerting:** Record latency per component. Alert if any component exceeds budget.

**Monitoring Strategy:**
```typescript
// Latency buckets per component (in EventService)
context_assembly: [100, 200, 300, 500];
llm_inference: [500, 1000, 1500, 2000];
tts_synthesis: [300, 500, 700, 1000];
playback_start: [100, 200, 300, 500];
total_latency: [2000, 2500, 3000, 4000]; // Alert if > 2000ms
```

### 3.3 Other KG Isolation Leakage

**Risk:** Code paths accidentally cross the isolation boundary between Person KGs and WKG/Self KG.

**Scenarios:**
- A query method in PersonModelingService accidentally returns a graph reference instead of a sanitized object.
- An upsert to a person's Grafeo graph modifies a shared node.
- A garbage collection cycle merges KG instances.

**Mitigation:**
1. **Type-level enforcement:** The sanitized `PersonModel` interface has no graph properties. TypeScript will catch attempts to access the graph.
2. **Strict internal access control:** The `grafeoInstances` map is private with no public getters.
3. **Isolation tests:** Unit tests explicitly verify that queries to Person KG do not affect WKG/Self KG and vice versa.
4. **Graph factory sealing:** When a Grafeo instance is created for a person, it is marked "sealed" — new nodes cannot be added, only properties updated on existing nodes.

**Test Pattern:**
```typescript
test('Person KG isolation: modifying Person_Jim does not affect WKG', async () => {
  const personModel = await personModelingService.getPersonModel('Person_Jim');
  const initialWKGNodeCount = await wkgService.countAllNodes();

  // Update Person_Jim's model
  await personModelingService.updateFromConversation('Person_Jim', someMessage);

  const finalWKGNodeCount = await wkgService.countAllNodes();
  expect(finalWKGNodeCount).toBe(initialWKGNodeCount);
});
```

### 3.4 Social Drive Contingency Timing Window

**Risk:** Detecting whether the guardian responded within the 30-second window is sensitive to:
- Clock skew between systems
- Network latency making response appear "late"
- Guardian's response being to an earlier comment, not the most recent

**Mitigation:**
1. **Timestamp at event creation, not delivery:** Record the timestamp when Sylphie's comment is emitted, not when it is rendered to the user.
2. **Causal linking:** When the guardian responds, include metadata about which Sylphie utterance they are responding to (either explicit or inferred from conversation context).
3. **Generous window:** Use 35 seconds instead of exactly 30 to account for network jitter.
4. **Per-comment tracking:** Each Sylphie-initiated utterance has a unique ID and carries its own 30-second window. Multiple comments can each earn their own reward if responded to within the window.

### 3.5 Cost Attribution and Budgeting

**Risk:** LLM costs accumulate without tracking per subsystem. Communication subsystem could monopolize the budget.

**Mitigation:**
1. **Per-call attribution:** Every LLM call includes a context tag: `input_parsing`, `response_generation`, `planning_simulation`, etc.
2. **Budget per subsystem:** Allocate total monthly budget to subsystems (e.g., Communication gets 50%, Planning gets 30%, Learning gets 20%).
3. **Monitoring and alerts:** Log cost per subsystem per session. Alert if any subsystem exceeds its budget allocation.
4. **Graceful degradation:** If Communication hits its budget, fall back to pre-synthesized responses or shorter responses (reduce maxTokens).

---

## 4. v1 Code Reuse Assessment

The task context mentions `co-being` repository with existing patterns for Communication. Specific reusable components:

### 4.1 Code Lift Candidates

| Component | v1 Location | Reusability | Effort |
|-----------|------------|-----------|--------|
| InputParserService structure | `co-being/packages/conversation-engine/src/parser/` | High | Low — adapt intent enums and entity types |
| DeterministicClassifierService | `co-being/packages/conversation-engine/src/classifier/` | High | Low — retrain on v2 intents |
| PersonModelService + PersonNode schema | `co-being/packages/reasoning-engine/src/services/person-model.service.ts` | High | Medium — adapt to Grafeo API, enforce isolation |
| ContextBundle assembly | `co-being/packages/reasoning-engine/src/services/decomposition.service.ts` | Medium | Medium — adapt drive injection, remove old context types |
| ConversationGateway (WebSocket) | `co-being/packages/backend/src/web/conversation.gateway.ts` | High | Low — rename, adjust routing |
| STT/TTS patterns | `co-being/packages/backend/src/voice/` | Medium | Medium — migrate to OpenAI Whisper/TTS, add streaming |
| SpeechSelectionService (latency optimization) | `co-being/packages/backend/src/orchestrator/speech-selection.service.ts` | High | Low — adapt to new architecture |
| Cost tracking patterns | `co-being/packages/backend/src/billing/` | Medium | Medium — adapt to Anthropic API pricing |

### 4.2 Clean-Room Rewrites Required

| Component | Reason |
|-----------|--------|
| **Theater Validator** | No equivalent in v1; new Immutable Standard 1 requirement |
| **Drive injection system prompt** | v1 did not have drive state; new design |
| **Grafeo isolation enforcement** | v1 used flat JSON; Grafeo is new architecture |
| **Response regeneration on Theater** | New feedback loop, not in v1 |

### 4.3 Adaptation Complexity Estimate

**High-value reuse opportunities:**
- InputParserService: 40% code lift, 60% new logic (drive handling, Theater integration)
- PersonModelService: 30% code lift, 70% new logic (Grafeo vs. old JSON)
- ConversationGateway: 60% code lift, 40% new routing

**Effort breakdown:**
- Parsing components: ~4 days (structure exists, logic adapts)
- Person modeling: ~5 days (Grafeo learning curve, isolation enforcement)
- Response generation: ~6 days (new Theater validation + drive injection)
- Voice pipeline: ~3 days (OpenAI API is simpler than v1 setup)
- WebSocket interface: ~2 days (straightforward adaptation)

**Total estimated effort with reuse: 20-25 days of implementation**

---

## 5. Proposed Ticket Breakdown

### Dependency Graph

```
E6-T001 (Type system & interfaces)
  |
  +---+---+---+---+---+---+---+
  |   |   |   |   |   |   |   |
  v   v   v   v   v   v   v   v
T002 T003 T004 T005 T006 T007 T008 T009
(DI) (Parse) (Person) (LLM) (Resp) (Theater) (STT/TTS) (Chatbox)
  |     |      |      |      |       |        |        |
  +-----+------+------+------+-------+--------+--------+
          |
          v
      E6-T010 (Integration & testing)
```

### Ticket Details

#### E6-T001: Type System & Interfaces (Size: M)
**Deliverable:** Type definitions for all Communication components, DI injection tokens, exceptions.

```typescript
// src/communication/types.ts
export interface ParsedInput { ... }
export interface ResponseGenerationContext { ... }
export interface PersonModel { ... }
export interface TheaterValidationResult { ... }
export interface TranscriptionResult { ... }

// src/communication/exceptions/
export class STTDegradationError extends Error { }
export class TTSDegradationError extends Error { }
export class TheaterDetectedException extends Error { }

// src/shared/tokens.ts
export const INPUT_PARSER_SERVICE = Symbol('INPUT_PARSER_SERVICE');
export const PERSON_MODELING_SERVICE = Symbol('PERSON_MODELING_SERVICE');
export const LLM_SERVICE = Symbol('LLM_SERVICE');
export const RESPONSE_GENERATOR_SERVICE = Symbol('RESPONSE_GENERATOR_SERVICE');
export const THEATER_VALIDATOR = Symbol('THEATER_VALIDATOR');
export const STT_SERVICE = Symbol('STT_SERVICE');
export const TTS_SERVICE = Symbol('TTS_SERVICE');
```

**Acceptance Criteria:**
- [ ] All interfaces are exported and documented
- [ ] DI tokens are registered in Communication module
- [ ] Type safety: no `any` types except where explicitly needed
- [ ] Interfaces match CANON terminology (ActionIntent, DriveSnapshot, etc.)

**Dependencies:** None

---

#### E6-T002: Communication Module Skeleton & DI Wiring (Size: M)
**Deliverable:** NestJS CommunicationModule with all providers registered, dependency injection configured.

```typescript
// src/communication/communication.module.ts
@Module({
  imports: [ConfigModule, KnowledgeModule, EventsModule, DriveEngineModule],
  providers: [
    InputParserService,
    PersonModelingService,
    LLMService,
    ResponseGeneratorService,
    TheaterValidator,
    STTService,
    TTSService,
    DeterministicClassifierService,
    ConversationService,
  ],
  exports: [
    INPUT_PARSER_SERVICE,
    PERSON_MODELING_SERVICE,
    LLM_SERVICE,
    RESPONSE_GENERATOR_SERVICE,
    THEATER_VALIDATOR,
  ],
})
export class CommunicationModule implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    // Initialize OpenAI client, prepare STT/TTS pipelines
  }

  async onModuleDestroy(): Promise<void> {
    // Cleanup audio streams, close OpenAI connections
  }
}
```

**Acceptance Criteria:**
- [ ] CommunicationModule loads without errors
- [ ] All services are injectable with full dependency graph
- [ ] OnModuleInit hook executes successfully
- [ ] Unit tests for dependency resolution pass

**Dependencies:** E6-T001, E2 (Events), E3 (Knowledge), E4 (Drive Engine)

---

#### E6-T003: Input Parser Service Implementation (Size: L)
**Deliverable:** Complete InputParserService with LLM-assisted parsing, entity resolution, Type 1/Type 2 arbitration.

**Key Methods:**
- `parse(input: string, source: 'TEXT' | 'VOICE'): Promise<ParsedInput>`
- `buildParsedInput(...): Promise<ParsedInput>`
- `constructParsingPrompt(input: string): string`
- `recordParsingEvent(...): Promise<void>`

**Acceptance Criteria:**
- [ ] Parser correctly identifies intents (QUESTION, STATEMENT, CORRECTION, etc.)
- [ ] Guardian feedback detection works (CORRECTION → 3x weight, TEACHING → learnable, etc.)
- [ ] Entity resolution cross-references WKG successfully
- [ ] Type 1 pattern matching falls back to LLM when confidence insufficient
- [ ] Latency tracking per parse
- [ ] Learnable aspects computed correctly
- [ ] Cost recorded to billing system
- [ ] Unit tests: 10+ scenarios (question, correction, unknown entities, etc.)
- [ ] Integration test with mock WKG

**Dependencies:** E6-T002, E3 (Knowledge), E2 (Events)

**Estimated effort:** 5 days

---

#### E6-T004: Person Modeling Service (Size: L)
**Deliverable:** PersonModelingService with strict Grafeo isolation, per-person KG instances.

**Key Methods:**
- `getPersonModel(personId: string): Promise<PersonModel>` (sanitized)
- `updateFromConversation(personId: string, conversation: Message): Promise<void>`
- `upsertToPersonGraph(graph: GrafeoGraph, update: PersonUpdate): Promise<void>`
- `recomputePersonModel(model: PersonModel, graph: GrafeoGraph): Promise<void>`

**Acceptance Criteria:**
- [ ] Each person gets isolated Grafeo instance
- [ ] `sanitizePersonModel()` removes all graph references
- [ ] Person KG updates do not affect WKG or Self KG (isolation test)
- [ ] Communication style computed from interaction history
- [ ] Topic preferences extracted and ranked
- [ ] Correction frequency tracked
- [ ] Response latency (mean + p95) computed
- [ ] Unit tests: isolation tests, update tests, sanitization tests
- [ ] Integration test: verify isolation with multiple concurrent persons

**Dependencies:** E6-T002

**Estimated effort:** 5 days

---

#### E6-T005: LLM Service & Cost Tracking (Size: M)
**Deliverable:** Complete LLMService with Anthropic API integration, token accounting, cost calculation, retry logic.

**Key Methods:**
- `complete(request: LLMRequest): Promise<LLMResponse>`
- `estimateCost(inputTokens, outputTokens, model): number`
- `retryWithBackoff(request, attempts): Promise<LLMResponse>`

**Acceptance Criteria:**
- [ ] Successfully calls Claude API with system+user prompts
- [ ] Token counts match Anthropic's token counter
- [ ] Cost calculation matches 2026-03-29 pricing
- [ ] Retry logic handles rate limits (429) and transient errors (503)
- [ ] Exponential backoff: 1s, 2s, 4s delays
- [ ] Cost tagged with context (input_parsing, response_generation, etc.)
- [ ] Unit tests: cost calculation, retry logic, error handling
- [ ] Integration test with live API (with test account)

**Dependencies:** E6-T002, E2 (Events for cost logging)

**Estimated effort:** 3 days

---

#### E6-T006: Response Generator Service (Size: L)
**Deliverable:** ResponseGeneratorService with context assembly, drive injection, Theater validation, response generation.

**Key Methods:**
- `generateResponse(request: ResponseGenerationRequest): Promise<ResponseGenerationResult>`
- `assembleContext(request): Promise<ResponseGenerationContext>`
- `constructPrompts(request, context): { systemPrompt, userPrompt }`
- `constructDriveNarrative(driveState): string`
- `regenerateWithConstraint(...): Promise<ResponseGenerationResult>`

**Acceptance Criteria:**
- [ ] Context assembly: drive state, person model, WKG knowledge, conversation history
- [ ] Drive state injected into system prompt (no exceptions)
- [ ] Person model integrated (communication style, preferences)
- [ ] Theater Prohibition validation called post-generation
- [ ] Re-generation on Theater detection with explicit constraint
- [ ] All responses tagged `has_learnable=true`
- [ ] Latency tracking per component (context, LLM, validation)
- [ ] Cost attribution to response_generation subsystem
- [ ] Unit tests: context assembly, prompt construction, drive narrative
- [ ] Integration test: full flow with mock LLM

**Dependencies:** E6-T005 (LLMService), E6-T006 (Theater Validator), E4 (Drive Engine)

**Estimated effort:** 6 days

---

#### E6-T007: Theater Validator (Size: M)
**Deliverable:** TheaterValidator with emotional valence extraction, drive-state correlation checking.

**Key Methods:**
- `validate(response: string, driveState: DriveSnapshot): Promise<TheaterValidationResult>`
- `analyzeEmotionalValence(response): Promise<{ valence, emotions }>`
- `computeDriveValence(driveState): number`
- `computeCorrelation(emotionalValence, driveValence): number`

**Acceptance Criteria:**
- [ ] LLM-assisted emotional valence extraction works
- [ ] Drive valence computed from 12 drives with appropriate weighting
- [ ] Correlation algorithm matches specification (1 - |difference| / 2)
- [ ] Theater threshold at 0.4 correctly flags theatrical responses
- [ ] Edge cases handled (low drive, neutral response = authentic, not theater)
- [ ] Reinforcement multiplier set correctly (0.0 for theater, 1.0 for authentic)
- [ ] Unit tests: valence extraction, correlation computation, threshold behavior
- [ ] Integration test: full response → validation → reinforcement flow

**Dependencies:** E6-T005 (LLMService for valence extraction)

**Estimated effort:** 3 days

---

#### E6-T008: STT Pipeline (Size: M)
**Deliverable:** STTService with OpenAI Whisper integration, graceful fallback.

**Key Methods:**
- `transcribe(audioBuffer: Buffer): Promise<TranscriptionResult>`
- `logprobToConfidence(segments): number`

**Acceptance Criteria:**
- [ ] Whisper API called successfully with verbose JSON response
- [ ] Word-level timestamps extracted and returned
- [ ] Logprob to confidence conversion works (maps [-2.0, 0] to [0, 1])
- [ ] STT success event recorded
- [ ] STT failure throws STTDegradationError (does not throw exception)
- [ ] Fallback allows chatbox to prompt for text
- [ ] Latency tracking
- [ ] Unit tests: success case, failure case, confidence mapping
- [ ] Integration test with recorded audio sample

**Dependencies:** E6-T002

**Estimated effort:** 2 days

---

#### E6-T009: TTS Pipeline (Size: L)
**Deliverable:** TTSService with sentence-level streaming, parallel synthesis, latency optimization.

**Key Methods:**
- `synthesizeAndPlay(text: string): Promise<void>`
- `splitIntoSentences(text): string[]`
- `synthesizeSentence(sentence, index): Promise<Buffer>`
- AudioController: `enqueue(buffer)`, `playNext()`

**Acceptance Criteria:**
- [ ] Sentence-level splitting works
- [ ] Parallel synthesis of multiple sentences
- [ ] Streaming playback: first sentence plays while others synthesize
- [ ] Latency to first byte tracked (should be < 500ms)
- [ ] Graceful fallback to text if TTS fails (throws TTSDegradationError)
- [ ] Error recovery: skip failed sentences, continue with next
- [ ] Audio controller maintains playback queue
- [ ] Unit tests: sentence splitting, synthesis, queue ordering
- [ ] Integration test: latency measurement, speech output on hardware

**Dependencies:** E6-T002

**Estimated effort:** 4 days

---

#### E6-T010: Chatbox Interface (Size: M)
**Deliverable:** ChatboxGateway with WebSocket support, message handling, event recording.

**Key Methods:**
- `afterInit(server)`
- `handleConnection(client, args)`
- `handleDisconnect(client)`
- `handleChatMessage(client, payload)`

**Acceptance Criteria:**
- [ ] WebSocket gateway initializes on /communication namespace
- [ ] Client connections tracked with person ID
- [ ] Chat message events recorded to TimescaleDB
- [ ] Input parsed and forwarded to response generator
- [ ] Response sent back to client with all metadata
- [ ] Error handling: client receives error events, not connection termination
- [ ] Graceful disconnect handling
- [ ] Unit tests: connection, message handling, disconnection
- [ ] Integration test: full flow from client message to response

**Dependencies:** E6-T003 (Input Parser), E6-T006 (Response Generator)

**Estimated effort:** 3 days

---

#### E6-T011: Social Drive Contingency Tracking (Size: M)
**Deliverable:** SocialDriveTracker service that timestamps Sylphie-initiated utterances and detects 30-second response windows.

**Key Methods:**
- `recordInitiatedUtterance(utteranceId, conversationId, personId): Promise<void>`
- `recordGuardianResponse(conversationId, personId, respondToUtteranceId?): Promise<void>`
- `computeContingencyEvent(utteranceId): Promise<ContingencyEvent | null>`

**Architecture:**
```typescript
interface TrackedUtterance {
  id: string;
  conversationId: string;
  personId: string;
  initiatedAt: Date;
  respondedAt?: Date;
  respondedWithinWindow: boolean;
}

@Injectable()
export class SocialDriveTracker {
  private readonly utterances: Map<string, TrackedUtterance> = new Map();
  private readonly WINDOW_MS = 35000; // 35 seconds with tolerance

  async recordInitiatedUtterance(
    utteranceId: string,
    conversationId: string,
    personId: string,
  ): Promise<void> {
    this.utterances.set(utteranceId, {
      id: utteranceId,
      conversationId,
      personId,
      initiatedAt: new Date(),
      respondedWithinWindow: false,
    });
  }

  async recordGuardianResponse(
    conversationId: string,
    personId: string,
    respondToUtteranceId?: string,
  ): Promise<void> {
    // Find the utterance this response is for (explicit or inferred)
    const utterance = this.findTargetUtterance(
      conversationId,
      respondToUtteranceId,
    );

    if (utterance) {
      const responseTime = Date.now() - utterance.initiatedAt.getTime();
      utterance.respondedAt = new Date();
      utterance.respondedWithinWindow = responseTime <= this.WINDOW_MS;

      if (utterance.respondedWithinWindow) {
        // Emit contingency event for Drive Engine
        await this.eventService.record({
          type: 'SOCIAL_DRIVE_CONTINGENCY',
          utteranceId: utterance.id,
          personId: utterance.personId,
          responseTimeMs: responseTime,
          reinforcementTriggered: true,
        });
      }
    }
  }

  private findTargetUtterance(
    conversationId: string,
    explicit?: string,
  ): TrackedUtterance | null {
    if (explicit) {
      return this.utterances.get(explicit) || null;
    }

    // Infer: find most recent unintelligenced utterance in this conversation
    let most Recent: TrackedUtterance | null = null;
    for (const [, utterance] of this.utterances) {
      if (
        utterance.conversationId === conversationId &&
        !utterance.respondedAt
      ) {
        if (!mostRecent || utterance.initiatedAt > mostRecent.initiatedAt) {
          mostRecent = utterance;
        }
      }
    }
    return mostRecent;
  }
}
```

**Acceptance Criteria:**
- [ ] Utterances tracked with unique IDs and timestamps
- [ ] 35-second window correctly identifies contingency
- [ ] Contingency event emitted to TimescaleDB
- [ ] Multiple utterances can each earn their own contingency
- [ ] Causal linking: response linked to specific utterance
- [ ] Unit tests: window boundary (34.9s pass, 35.1s fail), multiple utterances
- [ ] Integration test: full flow with conversation

**Dependencies:** E2 (Events)

**Estimated effort:** 2 days

---

#### E6-T012: Integration Test Suite & Performance Benchmarks (Size: L)
**Deliverable:** Comprehensive integration tests covering full Communication pipeline, latency benchmarks, isolation tests.

**Test Scenarios:**
1. End-to-end: guardian input → parse → response generation → validation → output
2. Theater detection: response with high emotion but low drive state
3. Person isolation: updating Person_Jim's model does not affect WKG
4. Social drive contingency: 30-second window detection
5. Latency profile: measure per-component latencies
6. Cost tracking: attribute cost to subsystem
7. Fallback pathways: STT failure → text prompt, TTS failure → text output
8. Concurrent users: multiple persons in simultaneous conversations

**Performance Benchmarks:**
```typescript
// target latencies
latency.contextAssembly < 300; // ms
latency.llmInference < 1500;  // ms
latency.ttsSynthesis < 500;   // ms (first byte)
latency.totalResponse < 2000; // ms
latency.parsing < 200;        // ms
cost.perResponse < $0.02;     // USD
```

**Acceptance Criteria:**
- [ ] All 8 test scenarios pass
- [ ] Latency benchmarks meet targets (or documented as TBD)
- [ ] Isolation tests demonstrate zero cross-contamination
- [ ] Cost tracking accurate to 5% of actual API costs
- [ ] All major code paths covered (>80% coverage)
- [ ] Performance tests run in CI/CD pipeline

**Dependencies:** All E6 tickets (T001-T011)

**Estimated effort:** 5 days

---

### Total Effort Estimate

| Ticket | Effort | Lead Time |
|--------|--------|-----------|
| E6-T001 | 2 days | Day 1 |
| E6-T002 | 2 days | Day 1 (parallel with T001) |
| E6-T003 | 5 days | Day 3 (after T002) |
| E6-T004 | 5 days | Day 3 (parallel with T003) |
| E6-T005 | 3 days | Day 3 (parallel with T003, T004) |
| E6-T006 | 6 days | Day 6 (after T005) |
| E6-T007 | 3 days | Day 6 (parallel with T006) |
| E6-T008 | 2 days | Day 6 (parallel with T006, T007) |
| E6-T009 | 4 days | Day 8 (after T006, T008) |
| E6-T010 | 3 days | Day 8 (parallel with T009) |
| E6-T011 | 2 days | Day 10 (after T010) |
| E6-T012 | 5 days | Day 12 (after all) |

**Parallelization window:** Days 1-2 (T001, T002), Days 3-5 (T003, T004, T005), Days 6-7 (T006, T007, T008), Days 8-9 (T009, T010), Days 10-11 (T011), Days 12-16 (T012)

**Critical path:** T001 → T002 → T005 → T006 → T009 (or T010) → T012 = ~13 days

**Estimated total: 18-21 days of implementation work** (with parallelization)

---

## 6. Drive State Injection Strategy

Every LLM response generation call must include drive state. This is not optional. Here's the injection strategy:

### 6.1 Injection Points

**Point 1: Response Generation (ResponseGeneratorService)**
```typescript
// Mandatory in every response generation
const driveState = await this.driveService.getCurrentDriveState();
const context = { ...context, driveState };
```

**Point 2: System Prompt Construction**
```typescript
const systemPrompt = `
You are Sylphie. Your current state:
${this.constructDriveNarrative(driveState)}

Speak authentically to this state.
`;
```

**Point 3: Post-Generation Validation**
```typescript
const validation = await theaterValidator.validate(
  llmResponse.text,
  context.driveState,
);
```

### 6.2 Drive Snapshot Format

```typescript
interface DriveSnapshot {
  systemHealth: number;        // Core: 0-1
  moralValence: number;        // Core: 0-1
  integrity: number;           // Core: 0-1
  cognitiveAwareness: number;  // Core: 0-1

  guilt: number;               // Complement: 0-1
  curiosity: number;           // Complement: 0-1
  boredom: number;             // Complement: 0-1
  anxiety: number;             // Complement: 0-1
  satisfaction: number;        // Complement: 0-1
  sadness: number;             // Complement: 0-1
  informationIntegrity: number; // Complement: 0-1
  social: number;              // Complement: 0-1

  timestamp: Date;
  context?: string;  // optional brief context (e.g., "post-failure", "high engagement")
}
```

### 6.3 Read-Only Access Pattern

The LLM service reads drive state but never writes to it:
```typescript
// OK: Read for context
const drives = await driveStateReader.getCurrentDriveState();

// NOT OK: Never do this
driveStateReader.setDriveValue('satisfaction', 0.5);
```

This is enforced by:
1. IDriveStateReader interface has only `getCurrentDriveState()`, no setter methods
2. Drive computation runs in isolated process (separate from main app)
3. Communication module depends on DriveEngineModule with read-only exports

---

## 7. Other KG Isolation Enforcement

Isolation is the most critical architectural constraint for Person modeling. Here's the enforcement strategy:

### 7.1 Module-Level Enforcement

```typescript
// src/communication/person-modeling/person-modeling.module.ts
@Module({
  providers: [
    PersonModelingService,
    GrafeoFactory,
  ],
  exports: [
    // Only export the service interface, NOT the internal graph instances
    PERSON_MODELING_SERVICE,
  ],
})
export class PersonModelingModule { }
```

**Key:** PersonModelingModule does NOT export GrafeoFactory or any graph references.

### 7.2 Type-Level Enforcement

```typescript
// Exported interface (public)
export interface PersonModel {
  id: string;
  role: 'GUARDIAN' | 'PEER' | 'STRANGER';
  firstEncounter: Date;
  communicationStyle: { /* properties only, no graph */ };
  observedStates: { /* properties only */ };
}

// Internal class (not exported)
class PersonModelInternal extends PersonModel {
  _grafeoGraph: GrafeoGraph; // private, never leaked
}
```

### 7.3 Query Interface Enforcement

```typescript
@Injectable()
export class PersonModelingService {
  // ✓ OK: Returns sanitized PersonModel
  async getPersonModel(personId: string): Promise<PersonModel> {
    const model = this.personModels.get(personId);
    return this.sanitizePersonModel(model); // removes _grafeoGraph
  }

  // ✗ NOT EXPORTED: Private method, never part of public interface
  private async upsertToPersonGraph(graph: GrafeoGraph, ...): Promise<void> {
    // writes ONLY to person's isolated graph
  }

  // ✓ OK: Upsert takes person ID, internally finds graph
  async updateFromConversation(personId: string, msg: Message): Promise<void> {
    // Internally finds the isolated Grafeo instance
    // User code cannot pass a graph reference
  }
}
```

### 7.4 Testing Isolation

```typescript
describe('Person KG Isolation', () => {
  test('modifying Person_Jim does not affect WKG', async () => {
    const initialWKGNodes = await wkgService.countAllNodes();

    // Create and update Person_Jim
    await personModelService.updateFromConversation(
      'Person_Jim',
      mockMessage,
    );

    const finalWKGNodes = await wkgService.countAllNodes();
    expect(finalWKGNodes).toBe(initialWKGNodes); // unchanged
  });

  test('PersonModel does not contain Grafeo reference', async () => {
    const model = await personModelService.getPersonModel('Person_Jim');
    expect((model as any)._grafeoGraph).toBeUndefined();
    expect((model as any).grafeoInstance).toBeUndefined();
  });

  test('direct Grafeo access prevented', async () => {
    // This should not compile (TypeScript)
    const model = await personModelService.getPersonModel('Person_Jim');
    // @ts-expect-error: no graph access
    const graph = model._grafeoGraph;
  });
});
```

---

## 8. Social Comment Quality Implementation

The Social drive contingency is: if the guardian responds within 30 seconds, Sylphie gets Social -0.15 + Satisfaction +0.10.

### 8.1 Utterance Tracking

```typescript
@Injectable()
export class SocialCommentQualityTracker {
  private readonly comments: Map<string, InitiatedComment> = new Map();

  async recordInitiatedComment(
    commentId: string,
    conversationId: string,
    personId: string,
    text: string,
  ): Promise<void> {
    this.comments.set(commentId, {
      id: commentId,
      conversationId,
      personId,
      text,
      initiatedAt: new Date(),
      respondedAt: null,
      withinWindow: false,
    });

    // Clean up old comments after 5 minutes
    setTimeout(
      () => this.comments.delete(commentId),
      5 * 60 * 1000,
    );
  }

  async recordGuardianResponse(
    conversationId: string,
    personId: string,
    responseText: string,
  ): Promise<void> {
    // Find the most recent unreplied comment
    const comment = Array.from(this.comments.values())
      .filter(c => c.conversationId === conversationId && !c.respondedAt)
      .sort((a, b) => b.initiatedAt.getTime() - a.initiatedAt.getTime())[0];

    if (!comment) return;

    const responseTime = Date.now() - comment.initiatedAt.getTime();
    comment.respondedAt = new Date();
    comment.withinWindow = responseTime <= 35000; // 35 seconds with tolerance

    if (comment.withinWindow) {
      // Emit contingency event
      await this.eventService.record({
        type: 'SOCIAL_COMMENT_QUALITY_HIT',
        commentId: comment.id,
        conversationId,
        personId,
        responseTimeMs: responseTime,
        commentText: comment.text,
        responseText,
        driveReward: { social: -0.15, satisfaction: 0.10 },
      });
    }
  }
}
```

### 8.2 Drive Engine Integration

The Drive Engine reads SOCIAL_COMMENT_QUALITY_HIT events and applies the reward:

```typescript
// In DriveEngine
async processDriveEvents(): Promise<void> {
  const socialEvents = await this.eventService.queryByType(
    'SOCIAL_COMMENT_QUALITY_HIT',
    { since: 'last_cycle' },
  );

  for (const event of socialEvents) {
    // Apply 2x Guardian weight (from CANON)
    await this.affectDrive('social', -0.15 * 2);      // Guardian response = 2x weight
    await this.affectDrive('satisfaction', 0.10 * 2);
  }
}
```

### 8.3 Timing Coordination

The 30-second window is tight. Here's the coordination:

1. **Sylphie initiates comment:** ResponseGeneratorService records timestamp in SocialCommentQualityTracker
2. **Guardian's response arrives:** InputParserService detects STATEMENT/ACKNOWLEDGMENT, passes to SocialCommentQualityTracker
3. **Contingency detected:** SocialCommentQualityTracker emits event to TimescaleDB if within 35-second window
4. **Drive Engine picks up:** Next drive cycle processes event and applies reward

**Latency budget for contingency detection:**
- Sylphie initiates: T+0ms
- Guardian responds: T+1-5s (network + typing)
- SocialCommentQualityTracker detects: T+5-10ms (local operation)
- Event recorded to TimescaleDB: T+50-100ms (with network)
- Drive Engine processes: T+100-500ms (next cycle tick)
- Total: well within 35-second window

---

## 9. Event Emission Strategy

Every Communication event must be tagged with `has_learnable` to signal whether the Learning subsystem should process it.

### 9.1 Learnable Events

**Always learnable (`has_learnable=true`):**
1. Input parsing with guardian feedback (CORRECTION, TEACHING)
2. Input parsing with unresolvedReferences (new entities)
3. Response generation (all successful responses feed Learning)
4. Guardian corrections to Sylphie's previous statements

**Conditionally learnable:**
1. Social drive contingency event (learning: this comment was good → increase social valence)
2. Person model updates (learning: Jim prefers X topics → adjust recommendation weights)

**Never learnable (`has_learnable=false`):**
1. Routine acknowledgments ("I see", "Okay")
2. Acknowledgments without new information
3. Theater detection flags (Learning processes authentic responses, not flagged ones)
4. Connection/disconnection events

### 9.2 Event Schema

```typescript
// src/communication/events/communication-events.ts

export interface CommunicationEventBase {
  type: string;
  timestamp: Date;
  personId: string;
  conversationId?: string;
  has_learnable: boolean;
  learnableAspects?: string[];  // e.g., ["new_entity", "correction", "social_quality"]
}

export interface InputParsedEvent extends CommunicationEventBase {
  type: 'INPUT_PARSED';
  raw: string;
  source: 'TEXT' | 'VOICE';
  intent: InputIntent;
  entities: string[];
  guardianFeedbackType?: 'CORRECTION' | 'CONFIRMATION' | 'TEACHING';
  unresolvedReferences: string[];
  has_learnable: true;  // always learnable
  learnableAspects: [
    ...(unresolvedReferences.length > 0 ? ['new_entity'] : []),
    ...(guardianFeedbackType === 'CORRECTION' ? ['correction'] : []),
    ...(guardianFeedbackType === 'TEACHING' ? ['teaching'] : []),
  ];
}

export interface ResponseGeneratedEvent extends CommunicationEventBase {
  type: 'RESPONSE_GENERATED';
  actionIntent: string;
  responseText: string;
  driveCorrelation: number;
  isTheater: boolean;
  latency: number;
  cost: number;
  has_learnable: true;  // all responses learnable
  learnableAspects: ['response'];
}

export interface SocialCommentQualityEvent extends CommunicationEventBase {
  type: 'SOCIAL_COMMENT_QUALITY_HIT';
  commentId: string;
  responseTimeMs: number;
  commentText: string;
  responseText: string;
  driveReward: { social: number; satisfaction: number };
  has_learnable: true;  // Learning: this comment was good
  learnableAspects: ['social_valence_positive'];
}

export interface PersonModelUpdateEvent extends CommunicationEventBase {
  type: 'PERSON_MODEL_UPDATE';
  personId: string;
  updateCount: number;
  updates: PersonUpdate[];
  has_learnable: false;  // Person modeling is Learning's job to read, not Vox's
}
```

### 9.3 Learning Subsystem Integration

The Learning subsystem (E3) subscribes to events with `has_learnable=true`:

```typescript
// In Learning subsystem
async consolidate(): Promise<void> {
  const learnableEvents = await this.eventService.queryLearnableEvents({
    since: 'last_consolidation',
    maxEvents: 5,  // prevent catastrophic interference
  });

  for (const event of learnableEvents) {
    if (event.type === 'INPUT_PARSED') {
      // Extract entities and edges from input
      await this.extractEntitiesFromInput(event as InputParsedEvent);
    }

    if (event.type === 'RESPONSE_GENERATED') {
      // Infer edges from response content
      await this.extractEdgesFromResponse(event as ResponseGeneratedEvent);
    }

    if (event.type === 'SOCIAL_COMMENT_QUALITY_HIT') {
      // Record: this phrasing produced a good response
      // Use this to refine future response generation
    }
  }
}
```

---

## 10. Summary: Critical Success Factors

For Epic 6 to succeed, the implementation must:

1. **Enforce Theater Prohibition consistently** — Every LLM call includes drive state; every response is validated post-generation
2. **Isolate Person KGs perfectly** — No cross-contamination with WKG or Self KG; isolation enforced at type level
3. **Meet latency threshold** — 2-second response time requires careful pipeline orchestration and streaming
4. **Track Social drive contingency accurately** — 30-second window, causal linking to specific utterances
5. **Tag learning events correctly** — Distinguish between learnable (INPUT_PARSED with feedback, RESPONSE_GENERATED) and non-learnable events
6. **Reuse v1 code judiciously** — Parser and person modeling structures exist; adapt carefully, don't copy-paste
7. **Cost track scrupulously** — Attribute every LLM call to subsystem; monitor budget per subsystem

---

## 11. Appendix: Module Structure Diagram

```
sylphie/
└── src/
    └── communication/
        ├── communication.module.ts (CommunicationModule)
        ├── types.ts (all type definitions)
        ├── exceptions/
        │   ├── stt-degradation.error.ts
        │   └── tts-degradation.error.ts
        ├── input-parsing/
        │   ├── input-parser.service.ts (IInputParserService)
        │   └── deterministic-classifier.service.ts (Type 1 attempt)
        ├── person-modeling/
        │   ├── person-modeling.service.ts (IPersonModelingService)
        │   └── person-modeling.module.ts
        ├── llm/
        │   ├── llm.service.ts (ILlmService)
        │   └── cost-tracker.service.ts
        ├── response-generation/
        │   ├── response-generator.service.ts
        │   ├── context-assembler.service.ts
        │   └── drive-narrative.builder.ts
        ├── theater/
        │   ├── theater-validator.ts
        │   └── emotional-valence-analyzer.ts
        ├── voice/
        │   ├── stt.service.ts (ISTTService)
        │   ├── tts.service.ts (ITTSService)
        │   └── audio-controller.ts
        ├── chatbox/
        │   ├── chatbox.gateway.ts (WebSocket)
        │   └── conversation.service.ts
        ├── social-drive/
        │   └── social-comment-quality-tracker.ts
        ├── events/
        │   └── communication-events.ts
        └── tests/
            ├── input-parser.integration.spec.ts
            ├── person-modeling.isolation.spec.ts
            ├── response-generator.e2e.spec.ts
            └── theater-validator.spec.ts
```

---

**Analysis complete. Ready for epic planning and ticket breakdown.**
