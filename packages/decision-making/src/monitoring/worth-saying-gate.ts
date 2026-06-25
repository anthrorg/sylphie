/**
 * WorthSayingGate — Decides when a SELF-INITIATED cycle is allowed to emit.
 *
 * TK-104: AD-0041 showed the bootstrap seed-greet wins every self-initiated
 * cycle at conf~0.81, causing Sylphie to utter the same canned greeting on
 * every unprompted turn. The rate-limit from TK-99 does not fix this — it only
 * slows the repetition. This gate enforces TWO additional conditions for
 * self-initiated cycles:
 *
 * 1. NOVELTY: The cycle has something genuinely new to say. Either:
 *    (a) A SALIENT_OBSERVATION — a novel scene event (cachedSceneSurprise
 *        above SCENE_NOVELTY_THRESHOLD), so Sylphie reacts to "the ball rolls
 *        into view" but stays silent on the unchanged static room; OR
 *    (b) A new GROUNDED insight (responseGrounding === 'GROUNDED') — new
 *        factual content grounded in the WKG/OKG that hasn't been said recently.
 *
 * 2. CONTENT-DEDUP: The response text is not identical (normalized) to a
 *    recent self-initiated utterance. Tracks the last RECENT_TEXT_CAPACITY
 *    self-initiated utterance hashes. An exact-match normalised duplicate is
 *    always suppressed regardless of novelty conditions.
 *
 * Guardian-prompted cycles (emitOriginator !== undefined) BYPASS this gate
 * entirely — the gate is for self-initiated speech only. A turn that came
 * from a guardian must always receive a response.
 *
 * CANON Standard 1 (Theater Prohibition): the gate reads real cognitive
 * state — scene surprise from the predictor, real grounding verdicts. It
 * never fabricates a reason for Sylphie to speak.
 *
 * CANON Standard 4 (Shrug Imperative): suppressing an emission from this
 * gate is NOT a SHRUG (the content was produced; the gate decided it wasn't
 * worth saying yet). No gap type is appended to recentGapTypes.
 */

// ---------------------------------------------------------------------------
// Gate constants
// ---------------------------------------------------------------------------

/**
 * Minimum cachedSceneSurprise (totalSurprise from ScenePredictionService)
 * for a scene event to count as "genuinely novel" and justify unprompted speech.
 *
 * ScenePredictionService.totalSurprise represents the summed per-object
 * prediction error across all tracked objects in the frame; it is roughly in
 * [0, N] where N is the number of tracked objects. A new, un-habituated object
 * entering the scene typically contributes a surprise of ~1.0 per object (the
 * predictor had confidence 0 on the new track). We use 0.30 as the threshold:
 * low enough to catch a single novel object, high enough to ignore minor
 * jitter on a stable scene.
 *
 * EMPIRICAL TUNING: raise this if Sylphie fires too readily on small scene
 * movements; lower it if she stays silent even when a clearly new object enters.
 */
export const SCENE_NOVELTY_THRESHOLD = 0.30;

/**
 * Rolling buffer capacity for recent self-initiated utterance hashes.
 *
 * The last RECENT_TEXT_CAPACITY self-initiated utterance normalised-hashes
 * are retained. A cycle whose response hash matches any of these is suppressed
 * by the content-dedup branch. A capacity of 10 covers ~2 minutes of activity
 * at the TK-99 10s cooldown, long enough to prevent obvious repetition.
 */
export const RECENT_TEXT_CAPACITY = 10;

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/** The gate's evaluation result for a single self-initiated cycle. */
export interface WorthSayingResult {
  /** Whether the cycle is allowed to emit. */
  readonly worthSaying: boolean;
  /** Human-readable reason (for logging / vlog). */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// WorthSayingGate
// ---------------------------------------------------------------------------

/**
 * Stateful gate that tracks recent utterances and evaluates whether a
 * self-initiated cycle has something worth saying.
 *
 * Not a NestJS service — instantiated directly by DecisionMakingService as a
 * private field. All state is in-process, intentionally ephemeral: the gate
 * resets on restart, which is fine because "do I repeat myself" only needs to
 * span the current session.
 */
export class WorthSayingGate {
  /** Circular buffer of normalised-text hashes from recent self-initiated emits. */
  private readonly recentHashes: string[] = [];

  /**
   * Evaluate whether a self-initiated cycle should emit its response.
   *
   * Algorithm:
   *   1. Dedup check first: if the normalised response text matches any recent
   *      self-initiated utterance, suppress unconditionally.
   *   2. If the cycle has a genuinely novel scene event (cachedSceneSurprise >=
   *      SCENE_NOVELTY_THRESHOLD), allow — the "ball rolls into view" case.
   *   3. If the cycle produced GROUNDED content (real factual grounding), allow.
   *   4. Otherwise suppress — static context, no new insight.
   *
   * @param responseText       - The proposed utterance text.
   * @param cachedSceneSurprise - Scene surprise cached early in the cycle
   *                             (ScenePredictionService.totalSurprise). Zero
   *                             when the frame has no scene snapshot.
   * @param responseGrounding  - Knowledge grounding of the proposed response.
   * @returns WorthSayingResult with worthSaying and a reason string for vlog.
   */
  evaluate(
    responseText: string,
    cachedSceneSurprise: number,
    responseGrounding: string,
  ): WorthSayingResult {
    const textHash = normaliseHash(responseText);

    // Step 1: Content dedup — suppress repeat of a recent self-initiated line.
    if (this.recentHashes.includes(textHash)) {
      return {
        worthSaying: false,
        reason: `CONTENT_DEDUP: response matches a recent self-initiated utterance (suppressed)`,
      };
    }

    // Step 2: Novel scene event — a new un-habituated object/person entered.
    if (cachedSceneSurprise >= SCENE_NOVELTY_THRESHOLD) {
      return {
        worthSaying: true,
        reason: `SALIENT_OBSERVATION: scene surprise=${cachedSceneSurprise.toFixed(3)} >= ${SCENE_NOVELTY_THRESHOLD}`,
      };
    }

    // Step 3: GROUNDED content — real factual content grounded in WKG/OKG.
    if (responseGrounding === 'GROUNDED') {
      return {
        worthSaying: true,
        reason: `GROUNDED_INSIGHT: response is grounded in WKG/OKG`,
      };
    }

    // Step 4: Unchanged context, no salient observation, no new grounding →
    // nothing worth saying this cycle.
    return {
      worthSaying: false,
      reason: `STATIC_CONTEXT: no novel scene event and no new grounded insight (suppressed)`,
    };
  }

  /**
   * Record a self-initiated utterance so future cycles can dedup against it.
   *
   * Call this ONLY after the cycle has actually emitted (responseSubject.next
   * called). If the cycle was suppressed by the gate, do NOT record the text —
   * the suppression means it wasn't said, so there is nothing to dedup against.
   *
   * @param responseText - The text that was emitted.
   */
  recordEmission(responseText: string): void {
    const textHash = normaliseHash(responseText);
    // Avoid recording duplicate hashes (idempotent for the same line).
    if (!this.recentHashes.includes(textHash)) {
      this.recentHashes.push(textHash);
      // Cap to RECENT_TEXT_CAPACITY by evicting the oldest entry.
      if (this.recentHashes.length > RECENT_TEXT_CAPACITY) {
        this.recentHashes.shift();
      }
    }
  }

  /** Number of utterances currently tracked (for testing and vlog). */
  get trackedCount(): number {
    return this.recentHashes.length;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Produce a normalised hash of a response text for dedup comparison.
 *
 * Normalisation: lower-case, collapse whitespace, strip leading/trailing space.
 * We do NOT use a cryptographic hash here — a normalised string comparison is
 * fast, readable in logs, and sufficient for dedup (the gate is checking for
 * identical or near-identical outputs, not adversarial collision resistance).
 */
export function normaliseHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
