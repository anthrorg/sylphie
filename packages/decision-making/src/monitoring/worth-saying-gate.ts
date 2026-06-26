/**
 * WorthSayingGate — decides WHEN a SELF-INITIATED cycle is allowed to emit.
 *
 * TK-104. AD-0041 showed the bootstrap seed-greet wins essentially every
 * self-initiated cycle (conf~0.81 vs threshold~0.57) and the system speaks the
 * same canned line on every unprompted turn. The TK-99 turn-floor only SLOWS
 * the repetition; it still lets the same line emit once per turn forever. This
 * gate adds the missing "is there anything WORTH saying" check (directive
 * points 3 + 6) on top of the TK-103 emission-intent seam.
 *
 * It keys on `emissionIntent`:
 *   - USER_REPLY      → the gate is BYPASSED. A user asked; she must answer.
 *                       (The gate never touches the user-reply generation path.)
 *   - DELIBERATE_GREET → BYPASSED. An intentional proactive bid (TK-100) is
 *                       worth saying by construction; rate is TK-99's job.
 *   - AMBIENT_NONE / SALIENT_OBSERVATION → this is a self-initiated perception /
 *                       idle cycle. The gate decides whether it speaks.
 *
 * For a self-initiated cycle the gate applies TWO rules:
 *
 *   1. CONTENT-DEDUP (AC0): if the normalised response text matches a recent
 *      self-initiated utterance, suppress unconditionally — two consecutive
 *      self-initiated cycles with unchanged context must NOT emit the same line
 *      twice. This holds even if novelty is high (we never repeat ourselves).
 *
 *   2. NOVELTY as a POSITIVE trigger (AC1): a genuinely novel salient
 *      perceptual event (scene surprise >= SCENE_NOVELTY_THRESHOLD — the
 *      "ball rolls into view that was not there before" case Jim called out)
 *      makes the cycle worth saying. Novelty is sourced from the scene
 *      predictor's surprise, which shares the TK-97 / AD-0005 familiarity curve:
 *      a static familiar scene yields ~0 surprise (un-habituated → high). A new
 *      grounded insight (responseGrounding === 'GROUNDED') also passes — real
 *      new information is worth saying. Anything else (static room, no new
 *      grounded content) is NOT worth saying → suppress.
 *
 * When the gate ALLOWS on novelty, the caller stamps the emission
 * SALIENT_OBSERVATION (she is reacting to the new thing, not narrating the
 * static remainder).
 *
 * CANON Standard 1 (Theater Prohibition): the gate reads only real cognitive
 * state (scene surprise from the predictor, real grounding verdicts, actual
 * recent utterances). It never fabricates a reason to speak.
 *
 * CANON Standard 4 (Shrug Imperative): a gate suppression is NOT a SHRUG — the
 * content WAS produced; the gate decided it was not worth saying yet. No gap
 * type is recorded and no SHRUG is emitted. The cycle simply stays silent
 * (exactly the AMBIENT_NONE behaviour: update state, emit nothing).
 *
 * Stateful, in-process, intentionally ephemeral (resets on restart): "do I
 * repeat myself" only needs to span the current session. Not a NestJS service —
 * instantiated directly by DecisionMakingService as a private field, mirroring
 * the lightweight-helper pattern already used in the cycle.
 */

import type { EmissionIntent, KnowledgeGrounding } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Gate constants
// ---------------------------------------------------------------------------

/**
 * Minimum scene surprise (ScenePredictionService.totalSurprise, cached early in
 * the cycle as `cachedSceneSurprise`) for a perceptual event to count as
 * "genuinely novel" and justify an unprompted comment.
 *
 * totalSurprise is the summed per-object prediction error across tracked
 * objects, roughly in [0, N]. A new, un-habituated object entering the scene
 * contributes ~1.0 (the predictor had ~0 confidence on the new track); a static
 * familiar scene that the predictor has habituated to sits near 0. 0.30 catches
 * a single novel object while ignoring minor jitter on a stable scene. Shares
 * the AD-0005 familiarity curve with the TK-97 habituator, so "static vs new"
 * is decided by the same notion of familiarity.
 *
 * EMPIRICAL TUNING: raise if she fires on small movements; lower if she stays
 * silent when a clearly new object enters.
 */
export const SCENE_NOVELTY_THRESHOLD = 0.3;

/**
 * Rolling buffer capacity for recent self-initiated utterance hashes. 10 covers
 * a comfortable window of self-initiated activity at the TK-99 cooldown — long
 * enough to prevent obvious repetition without unbounded growth.
 */
export const RECENT_TEXT_CAPACITY = 10;

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/** The gate's verdict for a single self-initiated cycle. */
export interface WorthSayingResult {
  /** Whether the cycle is allowed to emit. */
  readonly worthSaying: boolean;
  /**
   * The emission intent the caller should stamp when worthSaying is true.
   * SALIENT_OBSERVATION when allowed on novelty/new-grounded content (she is
   * reacting to the new thing). For a bypassed intent (USER_REPLY /
   * DELIBERATE_GREET) this echoes the incoming intent unchanged.
   */
  readonly intent: EmissionIntent;
  /** Human-readable reason (for logging / vlog). */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// WorthSayingGate
// ---------------------------------------------------------------------------

/** Inputs the gate evaluates for a single cycle. */
export interface WorthSayingInput {
  /** Emission intent classified at the cycle source (TK-103). */
  readonly emissionIntent: EmissionIntent;
  /** The proposed utterance text. */
  readonly responseText: string;
  /**
   * Scene surprise cached early in the cycle
   * (ScenePredictionService.totalSurprise). 0 when the frame had no scene.
   */
  readonly cachedSceneSurprise: number;
  /** Knowledge grounding verdict of the proposed response. */
  readonly responseGrounding: KnowledgeGrounding;
}

export class WorthSayingGate {
  /** Circular buffer of normalised-text hashes of recent self-initiated emits. */
  private readonly recentHashes: string[] = [];

  /**
   * Evaluate whether this cycle should emit.
   *
   * USER_REPLY and DELIBERATE_GREET BYPASS the gate (always worth saying).
   * For a self-initiated perception/idle cycle (AMBIENT_NONE on input — the
   * provisional classification before the gate refines it):
   *   1. Content-dedup: a repeat of a recent self-initiated line is suppressed.
   *   2. Novelty/new-grounded content makes it worth saying → SALIENT_OBSERVATION.
   *   3. Otherwise (static context, nothing new) → suppress.
   */
  evaluate(input: WorthSayingInput): WorthSayingResult {
    const { emissionIntent, responseText, cachedSceneSurprise, responseGrounding } = input;

    // A user turn or an intentional proactive bid is worth saying by
    // construction — the gate never gates these. (It never touches the
    // user-reply generation path: non_goal of TK-104.)
    if (emissionIntent === 'USER_REPLY' || emissionIntent === 'DELIBERATE_GREET') {
      return {
        worthSaying: true,
        intent: emissionIntent,
        reason: `BYPASS: ${emissionIntent} is always worth saying`,
      };
    }

    const textHash = normaliseHash(responseText);

    // Rule 1 — content dedup. A self-initiated repeat is suppressed even if the
    // scene is novel: we never say the same line twice in a row (AC0).
    if (textHash.length > 0 && this.recentHashes.includes(textHash)) {
      return {
        worthSaying: false,
        intent: 'AMBIENT_NONE',
        reason: 'CONTENT_DEDUP: matches a recent self-initiated utterance (suppressed)',
      };
    }

    // Rule 2 — novelty as a positive trigger (AC1): a genuinely novel salient
    // scene event is worth one comment → stamp SALIENT_OBSERVATION.
    if (cachedSceneSurprise >= SCENE_NOVELTY_THRESHOLD) {
      return {
        worthSaying: true,
        intent: 'SALIENT_OBSERVATION',
        reason: `SALIENT_OBSERVATION: scene surprise=${cachedSceneSurprise.toFixed(3)} >= ${SCENE_NOVELTY_THRESHOLD}`,
      };
    }

    // New grounded information is also worth saying.
    if (responseGrounding === 'GROUNDED') {
      return {
        worthSaying: true,
        intent: 'SALIENT_OBSERVATION',
        reason: 'SALIENT_OBSERVATION: response is grounded in new knowledge',
      };
    }

    // Static context, no novel event, no new grounded insight → nothing worth
    // saying. Stays AMBIENT_NONE (update state, emit nothing) — NOT a SHRUG.
    return {
      worthSaying: false,
      intent: 'AMBIENT_NONE',
      reason: 'STATIC_CONTEXT: no novel scene event and no new grounded insight (suppressed)',
    };
  }

  /**
   * Record a self-initiated utterance so future cycles can dedup against it.
   * Call ONLY after the cycle actually emitted. Never record a suppressed line
   * (it was not said, so there is nothing to dedup against). No-op for empty
   * text. Idempotent for an identical line.
   */
  recordEmission(responseText: string): void {
    const textHash = normaliseHash(responseText);
    if (textHash.length === 0 || this.recentHashes.includes(textHash)) {
      return;
    }
    this.recentHashes.push(textHash);
    if (this.recentHashes.length > RECENT_TEXT_CAPACITY) {
      this.recentHashes.shift();
    }
  }

  /** Number of utterances currently tracked (testing / telemetry). */
  get trackedCount(): number {
    return this.recentHashes.length;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a response text for dedup comparison: lower-case, collapse
 * whitespace, trim. A normalised string compare is fast, log-readable, and
 * sufficient for dedup (we check for identical/near-identical output, not
 * adversarial collisions).
 */
export function normaliseHash(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
