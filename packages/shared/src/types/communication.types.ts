/**
 * Communication subsystem types.
 *
 * CANON §Subsystem 2 (Communication): Handles input parsing, response
 * delivery (TTS + Chatbox), person modeling (Other Evaluation), and event
 * logging. These types define the data flowing through the Communication
 * pipeline from input receipt through response delivery.
 *
 * CycleResponse is emitted by Decision Making at the end of each executor
 * cycle. Communication subscribes to this stream, assembles full context,
 * validates Theater Prohibition, delivers the response, and logs events.
 *
 * Dependencies: drive.types.ts, action.types.ts
 */

import type { DriveSnapshot, PressureVector } from './drive.types';
import type { ArbitrationResult } from './action.types';

// ---------------------------------------------------------------------------
// KnowledgeGrounding — How well a response is backed by Sylphie's own knowledge
// ---------------------------------------------------------------------------

/**
 * Classification of how a response relates to Sylphie's actual knowledge.
 *
 * GROUNDED    — Response is based on entities/facts found in the WKG.
 *               Sylphie speaks confidently because she has first-hand knowledge.
 *
 * LLM_ASSISTED — Response uses the LLM's general training knowledge, NOT
 *                Sylphie's WKG. The response text is hedged with uncertainty
 *                markers ("I think...", "I'm not sure, but...").
 *
 * UNKNOWN     — Sylphie has no knowledge (WKG or otherwise) and honestly
 *               says she doesn't know.
 */
export type KnowledgeGrounding = 'GROUNDED' | 'LLM_ASSISTED' | 'UNKNOWN';

// ---------------------------------------------------------------------------
// Originator — identity of the speaker who triggered a cycle
// ---------------------------------------------------------------------------

/**
 * Identity of the turn originator (the person who sent the message that
 * triggered this cycle).
 *
 * WS4 Ticket 3: carried on CycleResponse and DeliveryPayload so downstream
 * consumers (gateway, Communication) know who to respond to.
 *
 * Self-initiated ticks (drive-pressure cycles, autonomous research) have no
 * originator — the `originator` field is absent/undefined for those cycles.
 *
 * CANON (provenance-required): userId is always the real speaker identity from
 * the verified JWT, never defaulted to guardian for a tokened non-guardian user.
 */
export interface TurnOriginator {
  /** PostgreSQL User.id for the speaker. */
  readonly userId: string;
  /** WebSocket socket ID of the originating connection (Ticket 4 targeted delivery). */
  readonly socketId?: string;
  /** Whether the speaker holds guardian status per their verified JWT. */
  readonly isGuardian: boolean;
}

// ---------------------------------------------------------------------------
// CycleResponse — Decision Making → Communication handoff
// ---------------------------------------------------------------------------

/**
 * Output of a completed decision cycle.
 *
 * Emitted by DecisionMakingService.response$ at the end of the LEARNING→IDLE
 * transition. Communication subscribes and uses this to generate the final
 * user-facing response.
 *
 * For SHRUG results, text is empty — Communication decides how to express
 * incomprehension based on the shrugDetail gap types.
 */
export interface CycleResponse {
  /** UUID for this response turn. Used for guardian feedback correlation. */
  readonly turnId: string;

  /**
   * Identity of the turn originator (WS4 Ticket 3).
   *
   * Present when this cycle was triggered by an inbound queued turn.
   * Absent (undefined) for self-initiated ticks (drive-pressure cycles,
   * autonomous research) — no speaker exists for those.
   *
   * Epoch-fence ordered: originator travels atomically with turnId as part
   * of the currentTurnContext captured before cycle start (same epoch-fence
   * discipline as the zombie guard so a late-resolving zombie can't emit
   * the successor's originator).
   */
  readonly originator?: TurnOriginator;

  /** LLM-generated response text. Empty string for SHRUG. */
  readonly text: string;

  /** Which arbitration path produced this response. */
  readonly arbitrationType: 'TYPE_1' | 'TYPE_2' | 'SHRUG';

  /** Procedure node ID, 'SHRUG', or a synthetic Type 2 ID. */
  readonly actionId: string;

  /** Drive state at cycle start. Required for Theater Prohibition validation. */
  readonly driveSnapshot: DriveSnapshot;

  /** Full arbitration result for outcome reporting. */
  readonly arbitrationResult: ArbitrationResult;

  /** Total cycle latency in milliseconds (IDLE→...→IDLE). */
  readonly latencyMs: number;

  /** LLM model used, if Type 2 was invoked. */
  readonly model?: string;

  /** Token usage, if LLM was called. */
  readonly tokensUsed?: { readonly prompt: number; readonly completion: number };

  /**
   * How well the response is grounded in Sylphie's own knowledge.
   * GROUNDED = WKG-backed, LLM_ASSISTED = hedged LLM knowledge, UNKNOWN = honest "I don't know".
   * Defaults to GROUNDED for Type 1 (latent space patterns are already validated knowledge).
   */
  readonly knowledgeGrounding: KnowledgeGrounding;

  /**
   * OKG provenance reference that backs a GROUNDED label (Standard 1).
   * For OKG recall: `attr-${personId}-${factKey}` — the deterministic Attribute node id.
   * Null when grounding is LLM_ASSISTED or UNKNOWN, or when the GROUNDED label
   * comes from a latent-space pattern whose entityIds were recorded at write time.
   */
  readonly groundingProvenance?: string | null;

  /**
   * Which knowledge graph produced a GROUNDED verdict (WS3 T5 / WS4 T5 §3.1).
   *   'OKG' → a person-model self-fact (lives in Neo4j OTHER, keyed on attr_id).
   *   'WKG' → a shared world-knowledge entity (lives in Neo4j WORLD, keyed on node_id).
   * Threaded so a consumer can verify groundingProvenance against the CORRECT live
   * instance. Null/undefined when grounding is not GROUNDED or the source is ambiguous.
   */
  readonly groundedBy?: 'OKG' | 'WKG' | null;

  /**
   * Drive pressure vector captured just before action execution (EXECUTING phase).
   *
   * Communication uses this to compute the real driveEffectsObserved delta by
   * comparing it to the post-delivery drive state. Without this snapshot, the
   * drive delta is unmeasurable and driveEffectsObserved would always be empty.
   */
  readonly preExecutionDriveSnapshot?: PressureVector;

  /**
   * Latent space pattern IDs written during this cycle's write-back phase.
   *
   * Populated when a new response is written to the latent space. Used by
   * reportOutcome() to update latent pattern confidence based on real outcome
   * data rather than the initial speculative confidence (0.3).
   */
  readonly latentPatternIds?: readonly string[];

  // ── Tensor cognition sidecar metadata (optional) ─────────────────────────

  /** Tensor model's top action category prediction, if sidecar was available. */
  readonly tensorTopCategory?: string;

  /** Tensor model's urgency signal [0,1], if sidecar was available. */
  readonly tensorUrgency?: number;

  /** Whether the 4 panel models reached consensus on this cycle. */
  readonly tensorConsensus?: boolean;

  /** Bootstrap mode at decision time: shadow | audit | partial | full. */
  readonly bootstrapMode?: string;

  /**
   * The exact 1561-dim assembled global input vector for this cycle, surfaced
   * by the cognition sidecar (fused_embedding[768] + drive_vector[12] +
   * drive_deltas[12] + total_pressure[1] + episodic_context[768]).
   *
   * Carried so the supervisor can thread it into reinforce/correct control
   * signals — the sidecar requires the byte-identical assembled vector and
   * cannot reconstruct it from CycleResponse fields. The vector is produced by
   * CognitiveCycle._assemble_global_input() and split back by the sidecar's
   * _split_input_vector(); copying it through (never reconstructing it) keeps
   * the two byte-identical.
   *
   * Optional and back-compatible: present only on cycles where the sidecar ran
   * and assembled a tensor. Undefined for non-tensor paths — in which case
   * reinforce/correct honestly skip for that cycle rather than fabricating one.
   *
   * Weight note: ~1561 floats ≈ 12KB of JSON per cycle. The supervisor samples
   * cycles, so it must be present on sampled cycles; correctness takes priority
   * over the payload cost.
   */
  readonly globalInputVector?: readonly number[];

  /**
   * Input category that triggered this cycle, from ProcessInputResult.
   *
   * Supervisor uses this for always-evaluate routing: GUARDIAN_FEEDBACK cycles
   * bypass the sampling gate regardless of cycleCount % sampleRate.
   */
  readonly inputCategory?: string;

  /**
   * Deliberation intent classification for this turn, copied (never recomputed)
   * from the inner-monologue classifier (MonologueClassification.intent):
   * GREETING | EMOTION | QUESTION | FACT | COMMAND | UNKNOWN.
   *
   * Threaded so Communication can persist it on the RESPONSE_GENERATED event,
   * where the self-model writer's knowledge_retrieval metric uses intent='QUESTION'
   * to restrict its denominator to turns where knowledge retrieval was actually
   * DEMANDED (CANON Std-1: counting social/greeting turns would measure chat
   * volume, not retrieval competence).
   *
   * Optional: present only on turns resolved through the deliberation pipeline
   * (the path where intent is reliably classified). Absent for procedure/latent
   * reflex turns and self-initiated ticks — those are correctly excluded from
   * the QUESTION-gated metric rather than fabricating an intent.
   */
  readonly intent?: string;
}

// ---------------------------------------------------------------------------
// InputParseResult — Communication's input parsing output
// ---------------------------------------------------------------------------

/**
 * Result of Communication's Input Parser.
 *
 * Per the architecture diagram: raw text input → Input Parser → TimescaleDB.
 * The parser classifies the input type, extracts entities, and detects
 * guardian feedback before the text enters the sensory pipeline.
 */
export interface InputParseResult {
  /** Classification of the input. */
  readonly inputType:
    | 'GREETING'
    | 'QUESTION'
    | 'STATEMENT'
    | 'COMMAND'
    | 'EMOTIONAL_EXPRESSION'
    | 'GUARDIAN_FEEDBACK'
    | 'UNKNOWN';

  /** The original text content. */
  readonly content: string;

  /** Entities extracted from the input (names, topics, concepts). */
  readonly entities: readonly string[];

  /** Guardian feedback type detected from the input. */
  readonly guardianFeedbackType: 'confirmation' | 'correction' | 'none';

  /** Session identifier for event correlation. */
  readonly sessionId: string;

  /** When the input was parsed. */
  readonly parsedAt: Date;
}

// ---------------------------------------------------------------------------
// DeliveryPayload — Communication → Gateway handoff
// ---------------------------------------------------------------------------

/**
 * Payload delivered to the gateway for WebSocket transmission.
 *
 * Contains everything the frontend needs to render the response:
 * text, audio (if TTS available), metadata badges, and correlation IDs.
 */
export interface DeliveryPayload {
  /** WebSocket message type. Frontend expects 'cb_speech'. */
  readonly type: 'cb_speech';

  /** Response text to display in the chatbox. */
  readonly text: string;

  /** Turn ID for guardian feedback correlation. */
  readonly turnId: string;

  /**
   * Identity of the turn originator (WS4 Ticket 3).
   *
   * Present when this delivery corresponds to an inbound queued turn.
   * Absent for self-initiated cycle deliveries and trigger-phrase bypasses.
   * Downstream consumers (gateway, Ticket 4 targeted delivery) use this to
   * route responses to the correct socket.
   */
  readonly originator?: TurnOriginator;

  /** Base64-encoded TTS audio, if synthesized. */
  readonly audioBase64?: string;

  /** Audio MIME type (e.g., 'audio/mpeg'). */
  readonly audioFormat?: string;

  /** Whether the response passed Theater Prohibition validation. */
  readonly isGrounded: boolean;

  /** Which arbitration path produced this response. */
  readonly arbitrationType: 'TYPE_1' | 'TYPE_2' | 'SHRUG';

  /** Total cycle latency in milliseconds. */
  readonly latencyMs: number;

  /** Whether the LLM was called (Type 2). */
  readonly llmCalled: boolean;

  /** LLM cost in USD (0 for local Ollama). */
  readonly costUsd?: number;

  /**
   * How well the response is grounded in Sylphie's own knowledge.
   * Frontend can use this to color/badge the response:
   *   GROUNDED    → normal color (confident)
   *   LLM_ASSISTED → different color/italic (hedged, tool-assisted)
   *   UNKNOWN     → muted/gray (honest "I don't know")
   */
  readonly knowledgeGrounding: KnowledgeGrounding;

  /**
   * Provenance node id backing a GROUNDED verdict (WS3 T5, forwarded from
   * CycleResponse.groundingProvenance). OKG: `attr-${personId}-${key}` in Neo4j
   * OTHER; WKG: the real `node_id` in Neo4j WORLD. Absent when not GROUNDED or
   * when the GROUNDED label came from a latent-space pattern that recorded no
   * single node id at write time.
   */
  readonly groundingProvenance?: string | null;

  /**
   * Which graph produced the GROUNDED verdict (WS3 T5): 'OKG' (→ Neo4j OTHER) or
   * 'WKG' (→ Neo4j WORLD). Lets a consumer pick the correct instance to verify
   * groundingProvenance against. Absent/null when not GROUNDED or ambiguous.
   */
  readonly groundedBy?: 'OKG' | 'WKG' | null;

  /**
   * Deliberation intent classification for this turn (forwarded from
   * CycleResponse.intent): GREETING | EMOTION | QUESTION | FACT | COMMAND |
   * UNKNOWN. Optional and back-compatible — absent for non-deliberation paths.
   * Carried so the gateway/log layer can persist it (knowledge_retrieval metric).
   */
  readonly intent?: string;
}
