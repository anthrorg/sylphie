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
 * 4. Validate Theater Prohibition (flag-only initially)
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
  type CycleResponse,
  type DeliveryPayload,
  type InputParseResult,
  type DriveSnapshot,
  type ActionOutcome,
  type OpportunityCreatedPayload,
} from '@sylphie/shared';
import {
  DECISION_MAKING_SERVICE,
  type IDecisionMakingService,
} from '@sylphie/decision-making';
import {
  DRIVE_STATE_READER,
  ACTION_OUTCOME_REPORTER,
  type IDriveStateReader,
  type IActionOutcomeReporter,
} from '@sylphie/drive-engine';
import { TtsService } from './tts.service';
import { ConversationHistoryService } from './conversation-history.service';
import { PersonModelService } from './person-model.service';
import { VoiceLatentSpaceService } from './voice-latent-space.service';

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
   * Pending turns awaiting guardian feedback. Keyed by turnId.
   * Used to associate late-arriving guardian feedback with the correct action.
   */
  private readonly pendingTurns = new Map<string, CycleResponse>();

  /** Maximum pending turns to retain (prevent unbounded growth). */
  private readonly MAX_PENDING_TURNS = 50;

  constructor(
    @Inject(DECISION_MAKING_SERVICE)
    private readonly decisionMaking: IDecisionMakingService,

    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,

    @Inject(ACTION_OUTCOME_REPORTER)
    private readonly outcomeReporter: IActionOutcomeReporter,

    private readonly timescale: TimescaleService,

    private readonly tts: TtsService,
    private readonly conversationHistory: ConversationHistoryService,
    private readonly personModel: PersonModelService,
    private readonly voiceCache: VoiceLatentSpaceService,
  ) {}

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
   */
  parseInput(text: string, sessionId: string): InputParseResult {
    const parsedAt = new Date();
    const entities = extractEntities(text);
    const inputType = classifyInput(text);
    const guardianFeedbackType = detectGuardianFeedback(text);

    // Log INPUT_RECEIVED event
    this.logEvent('INPUT_RECEIVED', sessionId, {
      content: text,
      inputLength: text.length,
    });

    // Log INPUT_PARSED event
    this.logEvent('INPUT_PARSED', sessionId, {
      inputType,
      entityCount: entities.length,
      entities,
      guardianFeedbackType,
    });

    // Add to conversation history
    this.conversationHistory.addUserMessage(text);

    // Record interaction with person model (Other Evaluation per architecture)
    // Default to 'guardian' as the active person — will be refined when
    // person identification is implemented.
    this.personModel.setActivePerson('guardian');
    this.personModel.recordInteraction('guardian', text, 'user');

    // Guardian Teaching Detection: check if this is a teaching/planning request.
    // If detected, writes GUARDIAN_TEACHING_DETECTED event to TimescaleDB for
    // Planning to pick up, and reports drive pressure via ActionOutcomeReporter.
    const teaching = detectGuardianTeaching(text);
    if (teaching) {
      this.handleGuardianTeaching(teaching, sessionId);
    }

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
  // Response Handling (architecture: Response Event → Text → TTS + Chatbox)
  // ---------------------------------------------------------------------------

  /**
   * Handle a CycleResponse from the Decision Making executor.
   *
   * This is the core response pipeline:
   * 1. Log RESPONSE_GENERATED event
   * 2. Validate Theater Prohibition (flag-only for now)
   * 3. Synthesize TTS audio if available
   * 4. Emit DeliveryPayload on delivery$ for the gateway
   * 5. Log RESPONSE_DELIVERED event
   * 6. Add to conversation history
   * 7. Store pending turn for guardian feedback correlation
   * 8. Call reportOutcome() to close the reinforcement loop
   */
  private async handleCycleResponse(response: CycleResponse): Promise<void> {
    const sessionId = response.driveSnapshot.sessionId;

    // Log RESPONSE_GENERATED
    this.logEvent('RESPONSE_GENERATED', sessionId, {
      turnId: response.turnId,
      arbitrationType: response.arbitrationType,
      actionId: response.actionId,
      textLength: response.text.length,
      model: response.model,
      latencyMs: response.latencyMs,
    });

    // Theater Prohibition check (flag-only — log warning but don't block)
    const isGrounded = this.checkTheaterProhibition(response);

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

    // Emit delivery payload for the gateway
    const delivery: DeliveryPayload = {
      type: 'cb_speech',
      text: response.text,
      turnId: response.turnId,
      ...(audioBase64 ? { audioBase64, audioFormat } : {}),
      isGrounded,
      arbitrationType: response.arbitrationType,
      latencyMs: response.latencyMs,
      llmCalled: response.arbitrationType === 'TYPE_2',
      costUsd: 0, // Local Ollama
      knowledgeGrounding: response.knowledgeGrounding,
    };

    this.deliverySubject.next(delivery);

    // Log RESPONSE_DELIVERED
    this.logEvent('RESPONSE_DELIVERED', sessionId, {
      turnId: response.turnId,
      textLength: response.text.length,
      hasAudio: !!audioBase64,
      voiceCacheHit,
      isGrounded,
      latencyMs: response.latencyMs,
    });

    // Add assistant response to conversation history
    if (response.text) {
      this.conversationHistory.addAssistantMessage(response.text);
      this.personModel.recordInteraction('guardian', response.text, 'assistant');
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

    // Report basic outcome to close the reinforcement loop
    await this.reportBasicOutcome(response);
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

    const sessionId = pendingResponse.driveSnapshot.sessionId;
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
        const outcome = feedbackType === 'confirmation' ? 'reinforced' : 'counter_indicated';
        // reportOutcome on IDecisionMakingService takes (actionId, ActionOutcome)
        // For guardian feedback, we construct a minimal outcome
        const driveSnapshot = this.driveStateReader.getCurrentState();
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
          anxietyAtExecution: driveSnapshot.pressureVector[DriveName.Anxiety] ?? 0,
          observedAt: new Date(),
        });
      } catch (err) {
        this.logger.warn(`reportOutcome for guardian feedback failed: ${err}`);
      }
    }

    // Remove from pending
    this.pendingTurns.delete(turnId);
  }

  // ---------------------------------------------------------------------------
  // Theater Prohibition (CANON Standard 1)
  // ---------------------------------------------------------------------------

  /**
   * Check whether the response correlates with the drive state.
   *
   * Currently flag-only: logs a warning if the response might not match the
   * drive state, but does not block delivery. Returns true (grounded) by
   * default. Full implementation requires sentiment analysis of the response
   * text vs drive state vector.
   */
  private checkTheaterProhibition(response: CycleResponse): boolean {
    if (!response.text) return true; // SHRUG — no response to validate

    // TODO: Implement real theater validation — compare response sentiment
    // against drive state. For now, flag if anxiety is very high but we have
    // a response (which might be inappropriately cheerful).
    const anxiety = response.driveSnapshot.pressureVector[DriveName.Anxiety] ?? 0;
    if (anxiety > 0.7 && response.text.length > 0) {
      this.logger.debug(
        `Theater check: anxiety=${anxiety.toFixed(2)} — response may not reflect internal state. ` +
          `Turn: ${response.turnId}`,
      );
      // Don't block — just flag. Return true for now.
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Outcome Reporting
  // ---------------------------------------------------------------------------

  /**
   * Report a basic outcome after response delivery.
   *
   * This closes the reinforcement loop for the current cycle without
   * waiting for explicit guardian feedback. If guardian feedback arrives
   * later via reportGuardianFeedback(), it will update the confidence again.
   */
  private async reportBasicOutcome(response: CycleResponse): Promise<void> {
    // Skip for SHRUG — no action to reinforce
    if (response.arbitrationType === 'SHRUG') return;

    // Skip for Type 2 novel responses without procedure data
    if (
      response.arbitrationType === 'TYPE_2' &&
      response.arbitrationResult.type === 'TYPE_2' &&
      response.arbitrationResult.candidate.procedureData === null
    ) {
      return;
    }

    try {
      const driveSnapshot = this.driveStateReader.getCurrentState();
      await this.decisionMaking.reportOutcome(response.actionId, {
        selectedAction: {
          actionId: response.actionId,
          arbitrationResult: response.arbitrationResult,
          selectedAt: new Date(),
          theaterValidated: true,
        },
        predictionAccurate: false, // Unknown until guardian feedback
        predictionError: 0.5,      // Neutral — will be updated by feedback
        driveEffectsObserved: {},
        anxietyAtExecution: driveSnapshot.pressureVector[DriveName.Anxiety] ?? 0,
        observedAt: new Date(),
      });
    } catch (err) {
      this.logger.warn(`reportBasicOutcome failed: ${err}`);
    }
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
      driveEffects: {
        [DriveName.CognitiveAwareness]: 0.3,
        [teaching.affectedDrive]: 0.2,
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
  ): void {
    const id = randomUUID();
    const driveSnapshot = this.driveStateReader.getCurrentState();

    this.timescale.query(
      `INSERT INTO events (id, type, timestamp, subsystem, session_id, drive_snapshot, payload, schema_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        eventType,
        new Date(),
        'COMMUNICATION',
        sessionId,
        JSON.stringify(driveSnapshot),
        JSON.stringify(payload),
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
