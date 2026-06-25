/**
 * CommunicationService — Core of the Communication subsystem.
 *
 * Per sylphie2.png architecture: Communication is a proper subsystem that
 * handles Input Parsing, Other Evaluation (person modeling), response
 * delivery (TTS + Chatbox), and event logging to TimescaleDB.
 *
 * This service sits between the Decision Making executor and the
 * ConversationGateway:
 *
 *   Decision Making (response$) → CommunicationService → delivery$ → Gateway
 *
 * Responsibilities:
 * 1. Parse input (classify, extract entities, detect guardian feedback)
 * 2. Subscribe to Decision Making's response$ stream
 * 3. Assemble full response context (drive state, person model, history)
 * 4. Validate Theater Prohibition (audit + zero-reinforce on violation)
 * 5. Synthesize TTS audio if available
 * 6. Emit DeliveryPayload on delivery$ for the gateway
 * 7. Log Communication events to TimescaleDB
 * 8. Call reportOutcome() to close the reinforcement loop
 *
 * CANON §Subsystem 2 (Communication): The LLM is Sylphie's voice, not her
 * mind. Communication generates the expression; Decision Making decides the
 * action.
 */

import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import { randomUUID } from 'crypto';
import {
  TimescaleService,
  DriveName,
  LLM_SERVICE,
  verboseFor,
  estimateLlmCostUsd,
  resolveLlmPricingFromEnv,
  type LlmPricingRates,
  type ILlmService,
  type CycleResponse,
  type DeliveryPayload,
  type InputParseResult,
  type DriveSnapshot,
  type OpportunityCreatedPayload,
} from '@sylphie/shared';
import {
  scoreAffect,
  NEGATIVE_VALENCE_THRESHOLD,
  MAGNITUDE_FLOOR,
} from './theater-affect-scorer';
import { buildResponseGeneratedPayload } from './response-generated-payload';
import { CycleOutcomeReporterService } from './cycle-outcome-reporter.service';

const vlog = verboseFor('Communication');
import {
  DECISION_MAKING_SERVICE,
  TickSamplerService,
  CycleGuardService,
  WkgContextService,
  type IDecisionMakingService,
  type InboundTurn,
  type QueuePositionSnapshot,
  type CandidatePromotionResult,
} from '@sylphie/decision-making';
import {
  DRIVE_STATE_READER,
  ACTION_OUTCOME_REPORTER,
  type IDriveStateReader,
  type IActionOutcomeReporter,
} from '@sylphie/drive-engine';
import { TtsService } from './tts.service';
import { ConversationHistoryService } from './conversation-history.service';
import { PersonModelService, extractFactsFromText } from './person-model.service';
import { VoiceLatentSpaceService } from './voice-latent-space.service';
import { FastFactWriterService } from './fast-fact-writer.service';

// ---------------------------------------------------------------------------
// CommunicationService
// ---------------------------------------------------------------------------

@Injectable()
export class CommunicationService implements OnModuleInit {
  private readonly logger = new Logger(CommunicationService.name);

  /** Output stream for the gateway to subscribe to. */
  private readonly deliverySubject = new Subject<DeliveryPayload>();

  /** Observable stream of delivery payloads. Gateway subscribes. */
  get delivery$(): Observable<DeliveryPayload> {
    return this.deliverySubject.asObservable();
  }

  /**
   * WS4 Ticket 6 — Queue-position update stream.
   *
   * Proxies CycleGuardService.queuePositionUpdates$ so the gateway can subscribe
   * without a direct dependency on the concurrency guard internals.
   *
   * Emits after every enqueue and every drain. The gateway subscribes and sends
   * honest `queue_position` messages to each waiting turn's socket using the
   * existing routeDelivery path.
   *
   * Lazily resolved from `this.cycleGuard` once `onModuleInit` completes.
   */
  get queuePositionUpdates$(): Observable<QueuePositionSnapshot> {
    return this.cycleGuard.queuePositionUpdates$;
  }

  /**
   * Pending turns awaiting guardian feedback. Keyed by turnId.
   * Used to associate late-arriving guardian feedback with the correct action.
   */
  private readonly pendingTurns = new Map<string, CycleResponse>();

  /** Maximum pending turns to retain (prevent unbounded growth). */
  private readonly MAX_PENDING_TURNS = 50;

  /**
   * DeepSeek pricing rates for costUsd computation on TYPE_2 deliveries.
   * Resolved once at construction from env vars (same source as CostTrackerService)
   * so delivery cost and supervisor cost can never drift.
   */
  private readonly pricingRates: LlmPricingRates;

  constructor(
    @Inject(DECISION_MAKING_SERVICE)
    private readonly decisionMaking: IDecisionMakingService,

    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,

    @Inject(ACTION_OUTCOME_REPORTER)
    private readonly outcomeReporter: IActionOutcomeReporter,

    @Inject(LLM_SERVICE)
    private readonly llm: ILlmService,

    private readonly timescale: TimescaleService,

    private readonly tts: TtsService,
    private readonly conversationHistory: ConversationHistoryService,
    private readonly personModel: PersonModelService,
    private readonly voiceCache: VoiceLatentSpaceService,

    // TK-34 (EP7-D): fast-fact KG writes extracted to a standalone service to
    // remove 4 KG-write deps (Neo4jService ×2, WkgDiffService, outcomeReporter)
    // from the Communication hot-path constructor.
    private readonly fastFactWriter: FastFactWriterService,

    // WS4 Ticket 2: needed to update conversation-context slots (history, speaker)
    // and to call recordInputArrival() for the self-tick 30s suppression guard.
    // TickSamplerService is exported from DecisionMakingModule and resolved by
    // NestJS DI from the global provider set.
    private readonly tickSampler: TickSamplerService,

    // WS4 Ticket 6: injected so we can proxy queuePositionUpdates$ to the gateway
    // without the gateway taking a hard dependency on the DM-internal concurrency guard.
    private readonly cycleGuard: CycleGuardService,

    // Wave 3 / C4: the WKG writer that performs the guardian candidate promotion
    // (`:Candidate → :Entity`). Provided by DecisionMakingModule + a module export,
    // resolved by NestJS DI (same path as metrics.controller's injection).
    private readonly wkgContext: WkgContextService,

    // TK-35 (EP7-E): theater check + basic outcome report extracted to isolate
    // CANON Std-1 audit logic from the delivery hot-path.
    private readonly cycleOutcomeReporter: CycleOutcomeReporterService,
  ) {
    this.pricingRates = resolveLlmPricingFromEnv();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onModuleInit(): void {
    this.logger.log('CommunicationService initializing — subscribing to response$.');

    this.decisionMaking.response$.subscribe({
      next: (response) => {
        void this.handleCycleResponse(response);
      },
      error: (err) => {
        this.logger.error(`response$ stream error: ${err}`);
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Input Parsing (architecture: Input Parser → TimescaleDB)
  // ---------------------------------------------------------------------------

  /**
   * Parse raw text input before it enters the sensory pipeline.
   *
   * Per architecture diagram: Text Input → Input Parser → TimescaleDB.
   * Classifies input, extracts entities, detects guardian feedback, and
   * logs INPUT_RECEIVED + INPUT_PARSED events.
   *
   * Also performs FAST FACT EXTRACTION: clear factual statements like
   * "My name is Jim" are written immediately to both the OKG (person model)
   * and WKG (world knowledge), bypassing the 60s learning cycle.
   *
   * @param text       - Raw text from the user.
   * @param sessionId  - Session identifier for event correlation.
   * @param userId     - PostgreSQL User.id for OKG person attribution.
   * @param isGuardian - Whether the speaker holds verified-JWT guardian status
   *                     (WS4 Ticket 5 §1). Threaded to writeFastFacts → writeFact
   *                     so OKG self-facts are tiered by the actual speaker's
   *                     guardian status, not identity-string matching. Defaults to
   *                     true to preserve legacy tokenless-guardian behavior.
   */
  parseInput(
    text: string,
    sessionId: string,
    userId: string = 'guardian',
    isGuardian = true,
  ): InputParseResult {
    const parsedAt = new Date();
    const entities = extractEntities(text);
    const inputType = classifyInput(text);
    const guardianFeedbackType = detectGuardianFeedback(text);

    // Log INPUT_RECEIVED event.
    // speakerId (= userId, the PostgreSQL User.id) is threaded so the 60s
    // learning cycle can person-scope conversation-derived entities (Wave 3 C3:
    // mint them as :Candidate with grounding_person_id = speakerId, not shared
    // :Entity — CANON Std-3 three-graph isolation, §2.8 leak fix).
    this.logEvent('INPUT_RECEIVED', sessionId, {
      content: text,
      inputLength: text.length,
      speakerId: userId,
    });

    // Log INPUT_PARSED event
    this.logEvent('INPUT_PARSED', sessionId, {
      inputType,
      entityCount: entities.length,
      entities,
      guardianFeedbackType,
      speakerId: userId,
    });

    // Self-model `social_interaction` (additive telemetry, no behavioral
    // consumer): a guardian inbound turn is a candidate "response" to a prior
    // proactive SOCIAL_COMMENT_INITIATED. The writer self-joins initiations to
    // guardian replies within 30s in the SAME session — so this MUST be keyed on
    // the DRIVE-session id (driveStateReader.getCurrentState().sessionId), the
    // same key SOCIAL_COMMENT_INITIATED uses. The `sessionId` param above is the
    // per-message gateway id, which the join does NOT reference. Emitting this
    // makes the social-interaction success numerator count genuine guardian
    // engagement (not only explicit GUARDIAN_CONFIRMATION). Std-1: real signal,
    // never fabricated.
    if (isGuardian) {
      this.logEvent(
        'GUARDIAN_INPUT_RECEIVED',
        this.driveStateReader.getCurrentState().sessionId,
        { userId, inputLength: text.length },
      );
    }

    // Add to conversation history
    this.conversationHistory.addUserMessage(text);

    // Record interaction with person model
    this.personModel.setActivePerson(userId);
    this.personModel.recordInteraction(userId);

    // ── Fast Fact Extraction ─────────────────────────────────────────────
    // Detect clear factual statements and write IMMEDIATELY to OKG + WKG.
    // This bypasses the 60s learning cycle for cold hard facts.
    const extractedFacts = extractFactsFromText(text);
    if (extractedFacts.length > 0) {
      this.logger.log(
        `Fast facts detected: ${extractedFacts.map((f) => `${f.key}="${f.value}"`).join(', ')}`,
      );
      // Fire-and-forget: delegate to FastFactWriterService (TK-34).
      void this.fastFactWriter.writeFastFacts(userId, extractedFacts, isGuardian);
    }

    // Guardian Teaching Detection: check if this is a teaching/planning request.
    // If detected, writes GUARDIAN_TEACHING_DETECTED event to TimescaleDB for
    // Planning to pick up, and reports drive pressure via ActionOutcomeReporter.
    const teaching = detectGuardianTeaching(text);
    if (teaching) {
      this.handleGuardianTeaching(teaching, sessionId);
    }

    // Inbound Hostility Detection (TK-86 — closes WS4 T8 blind spot).
    // Reuses the deterministic lexical affect scorer (no LLM, no RPC into
    // the drive). Only fires on strong negative valence above the threshold —
    // the same scorer used for Theater Prohibition validation so behaviour
    // is consistent and there is no new external dependency.
    this.detectAndReportInboundHostility(text, sessionId);

    vlog('input parsed', {
      inputType,
      entityCount: entities.length,
      guardianFeedback: guardianFeedbackType ?? null,
      factCount: extractedFacts.length,
      teaching: !!teaching,
    });

    return {
      inputType,
      content: text,
      entities,
      guardianFeedbackType,
      sessionId,
      parsedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // WS4 Ticket 2 — InboundTurn intake
  // ---------------------------------------------------------------------------

  /**
   * Receive and enqueue an inbound turn from the ConversationGateway.
   *
   * This is the single entry point for a new chat message into the
   * decision-making pipeline. It replaces the gateway's previous pattern of
   * calling parseInput() + tickSampler.updateText() separately, which left a
   * text-smear window where burst turns clobbered each other's text slot.
   *
   * Steps:
   *  1. Mint a stable turnId at this boundary (not inside processInput()).
   *  2. Run parseInput() — entity extraction, fast-fact writes, history add.
   *  3. Update all tickSampler context slots (history, speaker, person model).
   *  4. Call tickSampler.recordInputArrival() so the self-tick 30s guard fires.
   *  5. Construct the InboundTurn with turnId + text.
   *  6. Enqueue via decisionMaking.enqueueTurn() → CycleGuard.enqueue().
   *
   * The text is NOT written to the tickSampler text slot here — it travels on
   * the InboundTurn and is injected by runCycleForTurn() at drain time, so each
   * cycle gets its own text regardless of burst ordering.
   *
   * Returns the minted turnId so the gateway can send it back in input_ack if needed.
   *
   * Ticket 3 extension point: add userId, username, socketId, isGuardian to the
   * turn once identity threading lands. The commented fields on InboundTurn are
   * the seams.
   *
   * @param text        Raw text from the user.
   * @param sessionId   Session identifier for event correlation.
   * @param userId      PostgreSQL User.id (defaults to 'guest' — WS4 T7 tokenless default).
   * @param username    Display name of the speaker (defaults to 'guest').
   * @param isGuardian  Whether the speaker holds guardian status (WS4 Ticket 3).
   *                    WS4 T7 atomic flip: tokenless connections default to false.
   *                    Guardian status is only reachable via a signed JWT with isGuardian:true.
   * @param socketId    WebSocket connection ID for targeted delivery (Ticket 4).
   * @returns The minted turnId.
   */
  intakeTurn(
    text: string,
    sessionId: string,
    userId = 'guest',
    username = 'guest',
    isGuardian = false,
    socketId?: string,
  ): string {
    const turnId = randomUUID();
    const now = Date.now();

    // Step 2: parse input (entity extraction, fast-fact writes, history, etc.).
    // WS4 Ticket 5 §1: thread the turn's verified isGuardian so OKG self-facts
    // are tiered by the actual speaker, never re-derived from userId.
    this.parseInput(text, sessionId, userId, isGuardian);

    // Step 3: update tickSampler context slots so the cycle has fresh context.
    // These are additive slots (history accumulates); the last-written value before
    // the cycle drains is what the cycle uses — which is correct: we want the
    // current conversation state, not a snapshot from intake time.
    const splitHistory = this.conversationHistory.getSplitHistory();
    this.tickSampler.update('conversation_history', splitHistory.pending);
    this.tickSampler.update('conversation_summary', splitHistory.summary);
    this.tickSampler.update(
      'full_conversation_history',
      this.conversationHistory.getHistory(),
    );
    // WS4 Ticket 4: use getPersonModelForTurn(userId) — the explicit-userId
    // accessor — instead of getActivePersonModel(). This is cycle-bound code
    // where we know exactly which speaker this turn belongs to. The global
    // activePersonId slot is still updated inside parseInput() as the idle
    // fallback, but we key the tickSampler slot off the turn's own userId so
    // concurrent turns don't clobber each other's person-model context.
    this.tickSampler.update(
      'person_model',
      this.personModel.getPersonModelForTurn(userId),
    );
    this.tickSampler.update('speaker_name', username);

    // Step 4: record arrival so self-tick 30s suppression guard stays accurate.
    this.tickSampler.recordInputArrival();

    // Step 5: construct the turn with full identity (WS4 Ticket 3).
    // userId, username, socketId, isGuardian are now populated from the gateway JWT.
    // CANON provenance-required: userId must be the real speaker id from the
    // verified JWT, never falsely defaulted to guardian for a tokened non-guardian.
    const turn: InboundTurn = {
      turnId,
      isGuardian,
      receivedAt: now,
      enqueuedAt: now,
      text,
      userId,
      username,
      socketId,
    };

    // Step 6: enqueue through the concurrency guard.
    this.decisionMaking.enqueueTurn(turn);

    vlog('turn enqueued', {
      turnId,
      textPreview: text.substring(0, 80),
      userId,
      isGuardian,
      socketId: socketId ?? null,
    });

    return turnId;
  }

  // ---------------------------------------------------------------------------
  // Trigger Phrases
  // ---------------------------------------------------------------------------

  /**
   * Check whether the input is a trigger phrase and handle it directly.
   *
   * Trigger phrases short-circuit the normal sensory → decision-making pipeline
   * and produce an immediate response. Returns true if the input was handled
   * as a trigger (caller should skip the normal pipeline).
   *
   * Current triggers:
   *   - "Who am I?" → Retrieve OKG person model, LLM summarizes all known facts.
   *
   * WS4 Ticket 6: `socketId` and `isGuardian` are now accepted so `handleWhoAmI`
   * can construct a proper `TurnOriginator` and route the reply to the asker's
   * socket only — closing the privacy-scope leak identified in the Ticket 4 audit.
   *
   * @param socketId   - WebSocket connection ID of the requesting client (Ticket 6).
   * @param isGuardian - Whether the requesting user holds guardian status (Ticket 6).
   */
  async handleTriggerPhrase(
    text: string,
    sessionId: string,
    userId: string,
    socketId?: string,
    isGuardian?: boolean,
  ): Promise<boolean> {
    const trigger = detectTriggerPhrase(text);
    if (!trigger) return false;

    const startMs = Date.now();

    // Log the input events (same as parseInput — triggers still get logged)
    this.logEvent('INPUT_RECEIVED', sessionId, {
      content: text,
      inputLength: text.length,
    });
    this.logEvent('TRIGGER_PHRASE_DETECTED', sessionId, {
      trigger,
      originalText: text,
    });

    // Add to conversation history
    this.conversationHistory.addUserMessage(text);
    this.personModel.setActivePerson(userId);
    this.personModel.recordInteraction(userId);

    if (trigger === 'WHO_AM_I') {
      // WS4 Ticket 6: pass socketId and isGuardian so handleWhoAmI can attach
      // a proper TurnOriginator and route the reply to the asker only.
      await this.handleWhoAmI(sessionId, userId, startMs, socketId, isGuardian ?? false);
    }

    return true;
  }

  /**
   * Handle the "Who am I?" trigger.
   *
   * Loads all OKG facts for the speaker, sends them to the LLM with a prompt
   * to present everything Sylphie knows about this person, and emits the
   * response directly on delivery$.
   *
   * WS4 Ticket 6: socketId + isGuardian are accepted so the delivery can be
   * routed to the asker's socket only — closing the privacy-scope leak from T4.
   */
  private async handleWhoAmI(
    sessionId: string,
    userId: string,
    startMs: number,
    socketId?: string,
    isGuardian = false,
  ): Promise<void> {
    const turnId = `trigger-who-am-i-${randomUUID().substring(0, 8)}`;

    // Load all facts from OKG
    const facts = await this.personModel.loadFacts(userId);
    const personModel = this.personModel.getPersonModel(userId);

    // Build fact context for the LLM
    let factContext: string;
    if (facts.length === 0) {
      factContext = 'You have no recorded facts about this person yet.';
    } else {
      const factLines = facts.map(
        (f) =>
          `- ${f.key}: ${f.value} (confidence: ${(f.confidence * 100).toFixed(0)}%, source: ${f.source})`,
      );
      factContext =
        `Known facts about this person:\n${factLines.join('\n')}` +
        (personModel
          ? `\n\nInteraction summary: ${personModel.interactionSummary}`
          : '');
    }

    // Call LLM to generate a natural-language response
    let responseText: string;

    if (!this.llm.isAvailable()) {
      // Fallback: format facts directly without LLM
      responseText =
        facts.length === 0
          ? "I don't know anything about you yet. Tell me about yourself!"
          : `Here's what I know about you:\n${facts.map((f) => `${f.key}: ${f.value}`).join('\n')}`;
    } else {
      try {
        const llmResponse = await this.llm.complete({
          systemPrompt:
            'You are Sylphie, responding to someone who asked "Who am I?" ' +
            'Tell them everything you know about them based on the facts below. ' +
            'Be warm and personal — this is you recalling what you know about someone you talk to. ' +
            'If you have no facts, say so honestly and invite them to share about themselves. ' +
            'Keep it concise but thorough — cover every fact you have.',
          messages: [
            { role: 'user', content: `Person data:\n${factContext}\n\nRespond to their question: "Who am I?"` },
          ],
          maxTokens: 300,
          temperature: 0.4,
          tier: 'quick',
          metadata: {
            callerSubsystem: 'COMMUNICATION',
            purpose: 'TRIGGER_WHO_AM_I',
            sessionId,
          },
        });
        responseText = llmResponse.content;
      } catch (err) {
        this.logger.warn(`LLM call for WHO_AM_I trigger failed: ${err}`);
        responseText =
          facts.length === 0
            ? "I don't know anything about you yet. Tell me about yourself!"
            : `Here's what I know about you:\n${facts.map((f) => `${f.key}: ${f.value}`).join('\n')}`;
      }
    }

    const latencyMs = Date.now() - startMs;

    // Emit delivery directly (bypasses decision-making executor).
    // WS4 Ticket 6: originator is now threaded onto the delivery so the gateway
    // routes the WHO_AM_I reply to the asker's socket only — closing the privacy-
    // scope leak identified in the T4 audit (mythos, 2026-06-10). The originator
    // carries userId + socketId so routeDelivery() can target the exact socket.
    const delivery: DeliveryPayload = {
      type: 'cb_speech',
      text: responseText,
      turnId,
      originator: {
        userId,
        socketId,
        isGuardian,
      },
      isGrounded: true,
      arbitrationType: 'TYPE_2',
      latencyMs,
      llmCalled: true,
      costUsd: 0,
      knowledgeGrounding: facts.length > 0 ? 'GROUNDED' : 'UNKNOWN',
    };

    this.deliverySubject.next(delivery);

    // Log delivery
    this.logEvent('RESPONSE_DELIVERED', sessionId, {
      turnId,
      trigger: 'WHO_AM_I',
      textLength: responseText.length,
      factCount: facts.length,
      latencyMs,
    });

    // Add to conversation history
    this.conversationHistory.addAssistantMessage(responseText);
  }

  // ---------------------------------------------------------------------------
  // Response Handling (architecture: Response Event → Text → TTS + Chatbox)
  // ---------------------------------------------------------------------------

  /**
   * Handle a CycleResponse from the Decision Making executor.
   *
   * This is the core response pipeline:
   * 1. Log RESPONSE_GENERATED event
   * 2. Validate Theater Prohibition (audit + zero-reinforce on violation)
   * 3. Synthesize TTS audio if available
   * 4. Emit DeliveryPayload on delivery$ for the gateway
   * 5. Log RESPONSE_DELIVERED event
   * 6. Add to conversation history
   * 7. Store pending turn for guardian feedback correlation
   * 8. Call reportOutcome() to close the reinforcement loop
   */
  private async handleCycleResponse(response: CycleResponse): Promise<void> {
    const sessionId = response.driveSnapshot.sessionId;

    // Sanitize response text: strip LLM formatting artifacts before delivery.
    // Grounding tags like [UNKNOWN], [GROUNDED] and bracket-wrapped text
    // should never reach the user or TTS.
    response = { ...response, text: sanitizeResponseText(response.text) };

    // Log RESPONSE_GENERATED.
    // The payload (built by buildResponseGeneratedPayload) now carries
    // knowledgeGrounding + intent (reused from the response, never recomputed)
    // so the learning subsystem's knowledge_retrieval self-model metric has an
    // honest telemetry source: numerator = GROUNDED, denominator =
    // (GROUNDED|UNKNOWN) AND intent=QUESTION. intent is null on non-deliberation
    // paths (procedure/latent reflex) — correctly excluded from the QUESTION-
    // gated metric (CANON Std-1).
    this.logEvent('RESPONSE_GENERATED', sessionId, buildResponseGeneratedPayload(response));

    // Theater Prohibition check (CANON Standard 1). TK-101: now checks BOTH
    // affect mismatch AND capability claims / false-continuity fabrications.
    // TK-35 (EP7-E): delegated to CycleOutcomeReporterService.
    // Returns shouldBlock=true when a capability claim or false-continuity claim
    // fires — those must NEVER reach the user (see below).
    const theaterVerdict = this.cycleOutcomeReporter.checkTheaterProhibition(response);
    const isGrounded = !theaterVerdict.isTheatrical;

    // TK-101 BLOCK: fabricated capability claims and false-continuity claims are
    // withheld from delivery. Reinforcement is still reported (with
    // theaterValidated=false) so the LEARN path fires and confidence trends down.
    if (theaterVerdict.shouldBlock) {
      this.logger.warn(
        `[Theater Prohibition] BLOCKED — turn=${response.turnId}, ` +
          `class=${theaterVerdict.violationClass}, reason="${theaterVerdict.reason}"`,
      );
      // Still close the reinforcement loop so confidence drops (LEARN path).
      // Do NOT add to conversation history, do NOT emit to deliverySubject.
      await this.cycleOutcomeReporter.reportBasicOutcome(response, theaterVerdict);
      return;
    }

    // Voice output: check voice latent space FIRST, fall back to TTS on miss.
    // Every TTS-generated utterance is captured and stored so the same text
    // never hits the TTS API twice. ElevenLabs is a bootstrap dependency.
    let audioBase64: string | undefined;
    let audioFormat = 'audio/mpeg';
    let voiceCacheHit = false;

    if (response.text) {
      // Compute emotional valence from drive state for cache matching.
      // Different emotional states need different audio even for the same text.
      const valence = computeValence(response.driveSnapshot);

      // Type 1 voice path: check cache
      const cached = this.voiceCache.lookup(response.text, valence);

      if (cached) {
        audioBase64 = cached.pattern.audioBase64;
        audioFormat = cached.pattern.audioFormat;
        voiceCacheHit = true;
        this.logger.debug(
          `Voice cache HIT: "${response.text.substring(0, 30)}..." ` +
            `(uses=${cached.pattern.usageCount})`,
        );
      } else if (this.tts.available) {
        // Type 2 voice path: call TTS and capture the output
        try {
          const audioBuffer = await this.tts.synthesize(response.text);
          if (audioBuffer) {
            audioBase64 = audioBuffer.toString('base64');

            // Store in voice latent space for future Type 1 retrieval
            await this.voiceCache.store(
              response.text,
              audioBase64,
              audioFormat,
              valence,
            );
            this.logger.debug(
              `Voice cache MISS → TTS generated + cached: "${response.text.substring(0, 30)}..."`,
            );
          }
        } catch (err) {
          this.logger.warn(`TTS synthesis failed: ${err}`);
        }
      }
    }

    // Emit delivery payload for the gateway.
    // WS4 Ticket 3: thread originator from CycleResponse → DeliveryPayload.
    // Self-initiated ticks have no originator; absent originator is valid and
    // downstream consumers (gateway, Ticket 4 targeted delivery) must handle it.
    const delivery: DeliveryPayload = {
      type: 'cb_speech',
      text: response.text,
      turnId: response.turnId,
      ...(response.originator !== undefined ? { originator: response.originator } : {}),
      ...(audioBase64 ? { audioBase64, audioFormat } : {}),
      isGrounded,
      arbitrationType: response.arbitrationType,
      latencyMs: response.latencyMs,
      llmCalled: response.arbitrationType === 'TYPE_2',
      costUsd: computeDeliveryCost(response, this.pricingRates),
      knowledgeGrounding: response.knowledgeGrounding,
      // WS3 T5: forward the grounding provenance node id + its source so a
      // consumer (the Provability Gate, the frontend badge) can verify the id
      // resolves to a real node in the correct live Neo4j instance. Previously
      // CycleResponse carried these but cb_speech dropped them — T5's assertion
      // is on the delivered payload, so without this forward there was nothing
      // to verify even when the cycle had a real provenance id.
      ...(response.groundingProvenance != null
        ? { groundingProvenance: response.groundingProvenance }
        : {}),
      ...(response.groundedBy != null ? { groundedBy: response.groundedBy } : {}),
    };

    vlog('response delivered', {
      turnId: response.turnId,
      originator: response.originator ?? null,
      arbitrationType: response.arbitrationType,
      isGrounded,
      voiceCacheHit,
      hasAudio: !!audioBase64,
      textLen: response.text.length,
      latencyMs: response.latencyMs,
      costUsd: delivery.costUsd ?? 0,
    });

    if (delivery.costUsd && delivery.costUsd > 0) {
      this.logger.debug(
        `Delivery cost: $${delivery.costUsd.toFixed(6)} ` +
          `(${response.tokensUsed?.prompt ?? 0}+${response.tokensUsed?.completion ?? 0} tokens, ` +
          `model=${response.model ?? 'unknown'})`,
      );
    }

    this.deliverySubject.next(delivery);

    // Log RESPONSE_DELIVERED
    this.logEvent('RESPONSE_DELIVERED', sessionId, {
      turnId: response.turnId,
      text: response.text,
      textLength: response.text.length,
      hasAudio: !!audioBase64,
      voiceCacheHit,
      isGrounded,
      latencyMs: response.latencyMs,
    });

    // Add assistant response to conversation history
    if (response.text) {
      this.conversationHistory.addAssistantMessage(response.text);
      // WS4 Ticket 4: key recordInteraction off the turn's originator userId,
      // not the global activePersonId (which may have been clobbered by a
      // concurrent turn). For self-tick cycles (no originator), fall back to
      // the idle activePersonId — same behavior as before Ticket 4.
      const interactingId = response.originator?.userId ?? this.personModel.getActivePersonId() ?? 'guardian';
      this.personModel.recordInteraction(interactingId);
    }

    // Store pending turn for guardian feedback correlation
    this.pendingTurns.set(response.turnId, response);
    if (this.pendingTurns.size > this.MAX_PENDING_TURNS) {
      // Evict oldest
      const oldestKey = this.pendingTurns.keys().next().value;
      if (oldestKey !== undefined) {
        this.pendingTurns.delete(oldestKey);
      }
    }

    // Report basic outcome to close the reinforcement loop. The theater verdict
    // threads through so reinforcement is zeroed on a Standard-1 violation.
    // TK-35 (EP7-E): verdict was already computed above; pass it directly to
    // avoid a second scorer run.
    await this.cycleOutcomeReporter.reportBasicOutcome(response, theaterVerdict);
  }

  // ---------------------------------------------------------------------------
  // Guardian Feedback (architecture: Other Evaluation)
  // ---------------------------------------------------------------------------

  /**
   * Handle guardian feedback for a specific turn.
   *
   * Called by the gateway when the guardian sends a confirmation or correction.
   * Maps the turnId to the stored CycleResponse and calls reportOutcome()
   * with the guardian feedback applied (2x/3x weight per CANON Standard 5).
   */
  async reportGuardianFeedback(
    turnId: string,
    feedbackType: 'confirmation' | 'correction',
  ): Promise<void> {
    const pendingResponse = this.pendingTurns.get(turnId);
    if (!pendingResponse) {
      this.logger.warn(`Guardian feedback for unknown turnId: ${turnId}`);
      return;
    }

    // LEG 1b — guarantee a non-null session_id on the guardian event. The
    // self-model social_interaction self-join (SelfModelWriterService) keys
    // GUARDIAN_CONFIRMATION rows on session_id; a NULL drops the bid from the
    // success numerator. The stored CycleResponse snapshot is the authoritative
    // session for THIS turn, but if it is ever empty (cold start / a snapshot
    // that predated a real drive session) fall back to the live drive session so
    // the row always carries a traceable, joinable session id. No drive behavior
    // is touched — this only fixes the persisted session_id.
    const sessionId =
      pendingResponse.driveSnapshot.sessionId ||
      this.driveStateReader.getCurrentState().sessionId;
    if (!pendingResponse.driveSnapshot.sessionId) {
      this.logger.warn(
        `Guardian feedback for turn ${turnId} had empty stored sessionId; ` +
          `falling back to live drive session "${sessionId}".`,
      );
    }
    const eventType = feedbackType === 'confirmation'
      ? 'GUARDIAN_CONFIRMATION'
      : 'GUARDIAN_CORRECTION';

    this.logEvent(eventType, sessionId, {
      turnId,
      actionId: pendingResponse.actionId,
      feedbackType,
    });

    // Report outcome with guardian feedback to update confidence
    if (
      pendingResponse.actionId !== 'SHRUG' &&
      !pendingResponse.actionId.startsWith('type2-novel-')
    ) {
      try {
        const postSnapshot = this.driveStateReader.getCurrentState();

        await this.decisionMaking.reportOutcome(pendingResponse.actionId, {
          selectedAction: {
            actionId: pendingResponse.actionId,
            arbitrationResult: pendingResponse.arbitrationResult,
            selectedAt: new Date(),
            theaterValidated: true,
          },
          predictionAccurate: feedbackType === 'confirmation',
          predictionError: feedbackType === 'confirmation' ? 0.1 : 0.8,
          driveEffectsObserved: {},
          anxietyAtExecution: postSnapshot.pressureVector[DriveName.Anxiety] ?? 0,
          observedAt: new Date(),
        });
      } catch (err) {
        this.logger.warn(`reportOutcome for guardian feedback failed: ${err}`);
      }
    }

    // Remove from pending
    this.pendingTurns.delete(turnId);
  }

  /**
   * Wave 3 / chunk C4 — promote a staged `:Candidate` proper noun to a live,
   * grounding-eligible `:Entity` on guardian confirmation.
   *
   * Reaches the guardian-feedback channel via the ConversationGateway's
   * `guardian_feedback` handler (the candidate-selector variant). This thin
   * pass-through forwards to the WKG graph op (WkgContextService.promoteCandidate),
   * which enforces CANON Std-5 (guardian-only): a non-guardian `isGuardian=false`
   * is rejected inside the graph op BEFORE any write, so the candidate stays
   * non-groundable. No promotion logic lives here — Communication is the voice,
   * the WKG writer is the mind (CANON §Subsystem 2).
   *
   * @param selector  `{ candidateId }` or `{ label }` identifying the candidate.
   * @param isGuardian  the requesting socket's VERIFIED guardian status (JWT).
   * @returns the promotion outcome (promoted / rejected / not-found).
   */
  async promoteCandidate(
    selector: { candidateId?: string; label?: string },
    isGuardian: boolean,
  ): Promise<CandidatePromotionResult> {
    const result = await this.wkgContext.promoteCandidate(selector, isGuardian);
    if (result.promoted) {
      this.logEvent('GUARDIAN_CANDIDATE_PROMOTED', this.driveStateReader.getCurrentState().sessionId, {
        nodeId: result.nodeId,
        label: result.label,
        newConfidence: result.newConfidence,
        provenanceType: result.provenanceType,
      });
    } else if (result.reason === 'not_guardian') {
      this.logger.warn(
        `Candidate promotion rejected (CANON Std-5): non-guardian attempt ` +
          `for ${selector.candidateId ? `id="${selector.candidateId}"` : `label="${selector.label ?? ''}"`}.`,
      );
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Guardian Teaching
  // ---------------------------------------------------------------------------

  /**
   * Handle a detected guardian teaching request.
   *
   * Two responsibilities:
   * 1. Write a GUARDIAN_TEACHING_DETECTED event to TimescaleDB with the
   *    opportunity payload (CANON: cross-subsystem communication via event backbone).
   * 2. Report drive pressure via ActionOutcomeReporter to create motivational
   *    pressure (CognitiveAwareness + affected drive).
   */
  private handleGuardianTeaching(
    teaching: { affectedDrive: DriveName; instruction: string },
    sessionId: string,
  ): void {
    const opportunityId = randomUUID();
    const eventId = randomUUID();

    // 1. Write GUARDIAN_TEACHING_DETECTED event with OpportunityCreatedPayload.
    const opportunityPayload: OpportunityCreatedPayload = {
      id: opportunityId,
      contextFingerprint: `guardian-teaching:${teaching.instruction.substring(0, 80).toLowerCase().replace(/\s+/g, '-')}`,
      classification: 'GUARDIAN_TEACHING',
      priority: 'HIGH',
      sourceEventId: eventId,
      affectedDrive: teaching.affectedDrive,
      guardianInstruction: teaching.instruction,
    };

    this.timescale.query(
      `INSERT INTO events (id, type, timestamp, subsystem, session_id, drive_snapshot, payload, schema_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        eventId,
        'GUARDIAN_TEACHING_DETECTED',
        new Date(),
        'COMMUNICATION',
        sessionId,
        JSON.stringify(this.driveStateReader.getCurrentState()),
        JSON.stringify(opportunityPayload),
        1,
      ],
    ).catch((err: unknown) => {
      this.logger.warn(
        `Failed to log GUARDIAN_TEACHING_DETECTED event: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    // 2. Create drive pressure via outcome reporter.
    //    CognitiveAwareness increases (need to learn) + affected drive increases.
    this.outcomeReporter.reportOutcome({
      actionId: `guardian-teaching-${opportunityId}`,
      actionType: 'GuardianTeaching',
      success: false,
      metadata: {
        guardianTeachingDrive: teaching.affectedDrive,
      },
      feedbackSource: 'GUARDIAN',
      theaterCheck: {
        expressionType: 'none',
        correspondingDrive: null,
        driveValue: null,
        isTheatrical: false,
      },
    });

    this.logger.log(
      `Guardian teaching detected: "${teaching.instruction.substring(0, 60)}..." ` +
        `(affectedDrive=${teaching.affectedDrive}, opportunityId=${opportunityId})`,
    );
  }

  // ---------------------------------------------------------------------------
  // Inbound Hostility Detection (TK-86)
  // ---------------------------------------------------------------------------

  /**
   * Score the inbound message text for hostility and emit an InboundHostility
   * ActionOutcome when the lexical affect is strongly negative.
   *
   * Detection reuses the deterministic lexical affect scorer already imported for
   * Theater Prohibition — no new dependency, no LLM call. The same thresholds
   * (NEGATIVE_VALENCE_THRESHOLD, MAGNITUDE_FLOOR) keep the two subsystems aligned.
   *
   * The outcome is emitted as a push (ActionOutcomeReporter → IPC), never an RPC
   * read into the drive, satisfying the drive-event standard (CANON §Drive Isolation).
   *
   * Fires on: valence < NEGATIVE_VALENCE_THRESHOLD AND magnitude >= MAGNITUDE_FLOOR.
   * Neutral or positive messages are ignored (AC-3).
   */
  private detectAndReportInboundHostility(text: string, sessionId: string): void {
    const affectScore = scoreAffect(text);

    // Below detection floor or non-negative — not hostile.
    if (
      affectScore.magnitude < MAGNITUDE_FLOOR ||
      affectScore.valence >= NEGATIVE_VALENCE_THRESHOLD
    ) {
      return;
    }

    // hostilityMagnitude is the raw magnitude of the negative affect signal [0,1].
    const hostilityMagnitude = affectScore.magnitude;

    this.logger.debug(
      `[InboundHostility] detected — valence=${affectScore.valence.toFixed(2)}, ` +
        `magnitude=${hostilityMagnitude.toFixed(2)}, session=${sessionId}`,
    );

    // Push ActionOutcome over the existing IPC path. actionType is z.string() so
    // no validator schema change is needed (AD-0019 / DEC-24).
    this.outcomeReporter.reportOutcome({
      actionId: `inbound-hostility-${sessionId}-${Date.now()}`,
      actionType: 'InboundHostility',
      success: false,
      metadata: {
        hostilityMagnitude,
      },
      // INFERENCE → maps to 'algorithmic' at the IPC boundary (1x weight, no guardian asymmetry).
      feedbackSource: 'INFERENCE',
      theaterCheck: {
        expressionType: 'none',
        correspondingDrive: null,
        driveValue: null,
        isTheatrical: false,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Event Logging
  // ---------------------------------------------------------------------------

  /**
   * Log a Communication event to TimescaleDB.
   * Fire-and-forget — never blocks the response pipeline.
   */
  private logEvent(
    eventType: string,
    sessionId: string,
    payload: Record<string, unknown>,
    correlationId?: string | null,
  ): void {
    const id = randomUUID();
    const driveSnapshot = this.driveStateReader.getCurrentState();

    this.timescale.query(
      `INSERT INTO events (id, type, timestamp, subsystem, session_id, drive_snapshot, payload, correlation_id, schema_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        eventType,
        new Date(),
        'COMMUNICATION',
        sessionId,
        JSON.stringify(driveSnapshot),
        JSON.stringify(payload),
        correlationId ?? null,
        1,
      ],
    ).catch((err) => {
      this.logger.warn(`Failed to log ${eventType} event: ${err}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Compute the USD cost for a DeliveryPayload.
 *
 * Returns the real estimated cost when the cycle called the DeepSeek API
 * (identified by model name containing "deepseek"). Returns 0 for TYPE_1
 * reflexes, Ollama-local TYPE_2 cycles, and any cycle without token data.
 *
 * Uses the same estimateLlmCostUsd function as CostTrackerService so the
 * per-delivery cost figure is always in lockstep with the supervisor's budget
 * accounting — no separate rate table, no drift.
 */
function computeDeliveryCost(
  response: CycleResponse,
  rates: LlmPricingRates,
): number {
  // Only TYPE_2 cycles that called the LLM can have a non-zero cost.
  if (
    response.arbitrationType !== 'TYPE_2' ||
    !response.tokensUsed ||
    // Guard: model must be present and identify DeepSeek.
    // Local Ollama cycles are free; charging for them would be dishonest.
    !response.model?.toLowerCase().includes('deepseek')
  ) {
    return 0;
  }
  return estimateLlmCostUsd(
    response.tokensUsed.prompt,
    response.tokensUsed.completion,
    rates,
  );
}

/**
 * Sanitize response text before delivery. Strips LLM formatting artifacts
 * that should never reach the user or TTS:
 * - Grounding tags: [GROUNDED], [ASSISTED], [UNKNOWN]
 * - Bracket-wrapped responses: [Hi there! How are you?]
 * - Tool call text that leaked through: [person_query ...]
 * - Intent/Entity/Thought tags from monologue leaking into response
 */
function sanitizeResponseText(text: string): string {
  let cleaned = text.trim();
  if (!cleaned) return cleaned;

  // Strip leading grounding tags
  cleaned = cleaned.replace(/^\[?(GROUNDED|ASSISTED|UNKNOWN)\]?\s*/i, '');

  // Strip bracket-wrapped responses: "[Hi there!]" → "Hi there!"
  if (cleaned.startsWith('[') && !cleaned.startsWith('[...')) {
    const bracketEnd = cleaned.indexOf(']');
    if (bracketEnd > 0) {
      const inside = cleaned.substring(1, bracketEnd).trim();
      const after = cleaned.substring(bracketEnd + 1).trim();
      if (bracketEnd === cleaned.length - 1) {
        // Entire response is wrapped
        cleaned = inside;
      } else if (after.length > 3) {
        cleaned = after;
      } else {
        cleaned = inside;
      }
    }
  }

  // Strip tool call leakage (e.g., "[person_query {...}]")
  cleaned = cleaned.replace(/^\[(?:person_query|wkg_query|episodic_search|drive_state|web_search)\s*[{(].*$/im, '').trim();

  // Strip [INTENT: ...], [ENTITY: ...], [THOUGHT: ...] leakage
  cleaned = cleaned.replace(/\[(?:INTENT|ENTITY|THOUGHT):\s*[^\]]*\]\s*/gi, '').trim();

  // Strip trailing grounding tags
  cleaned = cleaned.replace(/\s*\[(?:GROUNDED|ASSISTED|UNKNOWN)\]\s*$/i, '').trim();

  // Strip leading dash/em-dash that sometimes prefixes responses
  cleaned = cleaned.replace(/^[-—–]\s+/, '');

  return cleaned;
}

/**
 * Detect whether the input is a trigger phrase that should short-circuit
 * the normal pipeline.
 *
 * Returns the trigger type string if matched, null otherwise.
 */
function detectTriggerPhrase(text: string): string | null {
  const lower = text.toLowerCase().trim().replace(/[?!.]+$/, '');

  if (/^who am i$/.test(lower)) return 'WHO_AM_I';
  if (/^what do you know about me$/.test(lower)) return 'WHO_AM_I';
  if (/^tell me what you know about me$/.test(lower)) return 'WHO_AM_I';
  if (/^what do you remember about me$/.test(lower)) return 'WHO_AM_I';

  return null;
}

function extractEntities(text: string): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 2);
  const entities: string[] = [];

  for (const word of words) {
    const clean = word.replace(/[.,!?;:'"]/g, '');
    if (/^[A-Z]/.test(clean) && clean.length > 1) {
      entities.push(clean);
    }
  }

  // Deduplicate
  return [...new Set(entities)];
}

function classifyInput(text: string): InputParseResult['inputType'] {
  const lower = text.toLowerCase().trim();

  if (/^(hi|hello|hey|good\s+(morning|afternoon|evening)|bye|goodbye)\b/i.test(lower)) {
    return 'GREETING';
  }
  if (/^(what|how|why|when|where|who|is|are|do|does|can|could|would)\b/.test(lower)) {
    return 'QUESTION';
  }
  if (/\b(please|can you|could you|do|help|show|tell)\b/.test(lower) && lower.length > 10) {
    return 'COMMAND';
  }
  if (/\b(feel|feeling|i'm|i am)\b/.test(lower) && /\b(sad|happy|anxious|angry|frustrated|excited)\b/.test(lower)) {
    return 'EMOTIONAL_EXPRESSION';
  }
  if (/\b(yes|no|correct|wrong|good|bad|nice|great|exactly|not quite)\b/.test(lower) && lower.length < 30) {
    return 'GUARDIAN_FEEDBACK';
  }

  return 'STATEMENT';
}

/**
 * Compute a scalar emotional valence from the drive snapshot.
 * Used by the voice latent space to match cached audio to emotional state.
 * Range [0.0, 1.0] where 0 = very negative, 0.5 = neutral, 1.0 = very positive.
 */
function computeValence(snapshot: DriveSnapshot): number {
  const pv = snapshot.pressureVector;
  // Positive contributors
  const satisfaction = pv[DriveName.Satisfaction] ?? 0;
  const curiosity = pv[DriveName.Curiosity] ?? 0;
  // Negative contributors
  const anxiety = pv[DriveName.Anxiety] ?? 0;
  const sadness = pv[DriveName.Sadness] ?? 0;
  const guilt = pv[DriveName.Guilt] ?? 0;

  const positive = satisfaction + curiosity * 0.5;
  const negative = anxiety + sadness + guilt * 0.5;
  const raw = 0.5 + (positive - negative) * 0.25;
  return Math.min(1.0, Math.max(0.0, raw));
}

/**
 * Detect whether the guardian is initiating a teaching/planning request.
 *
 * Teaching intent patterns:
 *   - "you should learn to ..."
 *   - "I want you to plan ..."
 *   - "learn how to ..."
 *   - "practice ..."
 *   - "work on ..."
 *   - "you need to ..."
 *
 * Returns null if no teaching intent is detected, or an object with the
 * inferred affected drive and the original instruction text.
 */
function detectGuardianTeaching(text: string): {
  affectedDrive: DriveName;
  instruction: string;
} | null {
  const lower = text.toLowerCase().trim();

  const teachingPatterns = [
    /\b(?:you should|i want you to|learn (?:how )?to|try to|practice|work on|you need to)\b/,
    /\b(?:plan how to|figure out how to|get better at|improve your)\b/,
    /\b(?:start|begin) (?:learning|practicing|working on)\b/,
  ];

  const isTeaching = teachingPatterns.some((p) => p.test(lower));
  if (!isTeaching) return null;

  return {
    affectedDrive: inferAffectedDrive(lower),
    instruction: text,
  };
}

/**
 * Infer which drive the guardian's teaching instruction most likely affects.
 * Falls back to CognitiveAwareness (learning need) if no specific drive is identified.
 */
function inferAffectedDrive(lower: string): DriveName {
  if (/\b(greet|hello|social|people|friend|talk|convers)\b/.test(lower)) return DriveName.Social;
  if (/\b(curious|learn|understand|know|explore|research)\b/.test(lower)) return DriveName.Curiosity;
  if (/\b(calm|relax|anxious|worry|stress)\b/.test(lower)) return DriveName.Anxiety;
  if (/\b(bored|boring|interest|engage)\b/.test(lower)) return DriveName.Boredom;
  if (/\b(right|wrong|moral|ethical|fair)\b/.test(lower)) return DriveName.MoralValence;
  if (/\b(focus|concentrate|attention|distract)\b/.test(lower)) return DriveName.Focus;
  if (/\b(happy|satisfy|enjoy|pleased)\b/.test(lower)) return DriveName.Satisfaction;
  if (/\b(sad|upset|lonely|miss)\b/.test(lower)) return DriveName.Sadness;
  if (/\b(guilt|sorry|apologize|fault)\b/.test(lower)) return DriveName.Guilt;
  return DriveName.CognitiveAwareness;
}

function detectGuardianFeedback(text: string): 'confirmation' | 'correction' | 'none' {
  const lower = text.toLowerCase().trim();

  if (/\b(yes|correct|exactly|good|great|perfect|nice|right|that's right)\b/.test(lower) && lower.length < 50) {
    return 'confirmation';
  }
  if (/\b(no|wrong|incorrect|not right|that's wrong|stop|don't)\b/.test(lower) && lower.length < 50) {
    return 'correction';
  }

  return 'none';
}

