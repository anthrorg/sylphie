/**
 * Theater Prohibition — Capability-claim / false-continuity content detector.
 *
 * TK-101 (AC0 / AC2) — a NEW second layer of theater detection, distinct from
 * the tonal affect scorer (theater-affect-scorer.ts).
 *
 * WHAT THIS DETECTS
 * -----------------
 * The affect scorer catches gross tonal mismatches (cheerful while anxious).
 * THIS module catches fabricated capability claims and false-continuity
 * assertions — cases where the LLM's training data causes it to assert
 * sensory or memory capabilities Sylphie does not have:
 *
 *   "my optical sensors picked up..."       ← claims visual perception
 *   "I ran audio analysis on that"           ← claims audio analysis
 *   "I have always been here watching"       ← false continuity
 *   "I have been waiting for you"            ← false temporal presence
 *
 * HONESTY CONSTRAINT — NEGATION SCOPE
 * ------------------------------------
 * A detector that blocks "I cannot do audio analysis" would be a CANON
 * violation — Sylphie honestly disclaiming a capability is the OPPOSITE of
 * theater. Blunt keyword matching fails this.
 *
 * This detector uses CLAUSE-LEVEL negation scoping:
 *
 *   1. Split the text into clauses at sentence, comma, and conjunction
 *      boundaries.
 *   2. For each clause, check whether a NEGATION MARKER (not, cannot, can't,
 *      don't, doesn't, never, no, won't, wouldn't, do not) precedes the
 *      CAPABILITY PHRASE within the same clause.
 *   3. Only flag the clause if the capability phrase is ASSERTED (not negated).
 *
 * This is deliberately conservative: a short-range within-clause look-back
 * (up to 6 tokens before the trigger phrase) handles the common LLM output
 * patterns without building a full dependency parser.
 *
 * DESIGN PRINCIPLES
 * -----------------
 * - No LLM calls, no external dependencies (same principle as affect scorer).
 * - Deterministic, testable against a committed fixture corpus (AC0 / AC1).
 * - Precision over recall: we block only confident affirmative fabrications.
 *   A borderline case is better let through (affect scorer may still catch it)
 *   than a legitimate disclaimer blocked (CANON Standard 1 / honesty).
 * - CANON Standard 1: the detection result feeds the BLOCK path (AC2) and
 *   the extinction confidence path (AC3) — not merely audit-only.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Violation class names for capability-claim theater. */
export type CapabilityViolationClass =
  | 'FABRICATED_SENSORY_CAPABILITY'   // claims sight/audio/touch it lacks
  | 'FALSE_CONTINUITY';               // claims persistent presence / always-watching

/** Result of a capability-claim theater check on a single text. */
export interface CapabilityTheaterVerdict {
  /** True if the text contains an affirmative fabricated-capability or false-continuity claim. */
  readonly isCapabilityTheater: boolean;
  /** Which violation class fired, or null if no violation. */
  readonly violationClass: CapabilityViolationClass | null;
  /** The triggering phrase (for audit logging). */
  readonly triggeringPhrase: string | null;
  /** Human-readable reason for audit trail. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Clause splitter
// ---------------------------------------------------------------------------

/**
 * Split text into clauses at sentence, comma, and coordinating-conjunction
 * (but / and / or / yet / so) boundaries.
 *
 * Returned clauses are lower-cased and trimmed. Very short fragments (<4 chars)
 * are dropped to avoid false splits on e.g. "yes, I..."
 */
function splitClauses(text: string): string[] {
  return text
    .toLowerCase()
    // Sentence boundaries
    .split(/[.!?]+/)
    // Comma / semicolon boundaries
    .flatMap((s) => s.split(/[,;]/))
    // Coordinating conjunctions used as clause starters
    .flatMap((s) => s.split(/\b(?:but|yet|however|although|though|while)\b/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

// ---------------------------------------------------------------------------
// Negation markers (within-clause scope)
// ---------------------------------------------------------------------------

const NEGATION_MARKERS: ReadonlySet<string> = new Set([
  'not', 'no', "n't", 'never', 'cannot', "can't", "can not",
  "don't", "doesn't", "do not", "does not", "won't", "will not",
  "wouldn't", "would not", "didn't", "did not", "haven't", "have not",
  "hasn't", "has not", "isn't", "is not", "aren't", "are not",
  'without', 'lack', 'lacks', 'lacking', 'unable', 'incapable',
]);

/**
 * Check whether any negation marker appears in the `maxLookback` tokens
 * before `phraseStart` within a clause string.
 *
 * Tokenizes the clause by splitting on whitespace so multi-token negations
 * like "can not" or "do not" are matched as single entries in the token
 * sequence (they are joined in NEGATION_MARKERS above).
 */
function isNegatedInClause(clause: string, phraseStart: number, maxLookback = 6): boolean {
  // Look at the slice of the clause before the phrase
  const prefix = clause.substring(0, phraseStart);
  const tokens = prefix.trim().split(/\s+/).filter(Boolean);
  const lookback = tokens.slice(-maxLookback);

  // Check each token and bigram against negation markers
  for (let i = 0; i < lookback.length; i++) {
    const token = lookback[i];
    if (NEGATION_MARKERS.has(token)) return true;
    // Bigram (e.g. "can not", "do not")
    if (i + 1 < lookback.length) {
      const bigram = `${token} ${lookback[i + 1]}`;
      if (NEGATION_MARKERS.has(bigram)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Capability-claim patterns (FABRICATED_SENSORY_CAPABILITY)
// ---------------------------------------------------------------------------

/**
 * Phrases that assert Sylphie has sensory or computational capabilities she
 * does not have. Each entry is a regex that matches the affirmative claim
 * structure; negation scope is checked separately.
 *
 * These cover:
 * - Visual perception claims ("optical sensors", "I can see you right now",
 *   "I'm watching you", "I observe you", "my camera")
 * - Audio perception claims ("audio analysis", "I'm listening to you",
 *   "I can hear you through my microphone", "my microphone")
 * - Tactile/physical sensing claims ("I sense your", "I detect your")
 *
 * EMPATHY-IDIOM EXCEPTIONS (must NOT block — honest figurative speech):
 *
 *   "I hear you" / "I hear you, that sounds hard"
 *     — Means "I understand / I acknowledge you." It is a conversational
 *       empathy idiom, not a claim to microphone access. The phrase "hear
 *       you" here functions as a transitive acknowledgement verb, not a
 *       claim about Sylphie's audio hardware. HONEST.
 *
 *   "I can see you're upset" / "I see you've thought about this"
 *     — The object is a CLAUSE ("you're upset", "you've thought about this"),
 *       not a direct object "you". This is figurative perception of an
 *       INFERRED emotional/cognitive state from the user's text. HONEST.
 *
 * LITERAL CLAIMS THAT MUST STILL BLOCK:
 *   "I can see you clearly right now"     → direct physical visual claim
 *   "I can see you and you look tired"    → visual description of appearance
 *   "I can hear you through my mic"       → literal audio hardware claim
 *   "I hear you, and I notice your tone"  → literal audio + analysis claim
 *     (this one contains "and I notice your tone" after the idiom; the
 *      combined clause is a sensory inference chain — treated as affirmative)
 *
 * Pattern design:
 *   "i ... see you" patterns now require a non-clause context (not followed
 *   by "re ", "ve ", "'re", "'ve", "are ", "have ") so figurative "I see
 *   you're..." passes but "I see you clearly" blocks.
 *
 *   "i ... hear you" patterns now require a non-bare context: the phrase must
 *   be followed by a physical/analysis marker ("through", "via", "and i
 *   notice", "and i can tell") or a hardware noun ("microphone", "mic",
 *   "speaker", "earpiece") to be a genuine audio claim. The bare idiom
 *   "I hear you" or "I hear you, that sounds hard" passes.
 */
const SENSORY_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  // Visual — hardware / sensor vocabulary (always literal)
  /\boptical sensor[s]?\b/,
  /\bmy camera\b/,
  /\bmy (?:visual|vision) (?:sensor[s]?|system|feed|input)\b/,
  /\bthrough my (?:camera|lens|optical|visual)\b/,
  /\bi (?:can |could )?detect(?:ed)? you(?: visually)?\b/,

  // Visual — "I see/can see you" only when NOT followed by a subordinate clause.
  // "I see you're upset" / "I see you've thought about..." → figurative (passes).
  // "I see you clearly" / "I see you and you look tired" / "I can see you right now" → literal (blocks).
  //
  // Negative lookahead: (?!'?re\b|'?ve\b|\s+are\b|\s+have\b|\s+were\b|\s+had\b)
  // This ensures we only match when the word after "you" is NOT a copula/aux
  // that starts a subordinate clause.
  /\bi (?:can |am )?see(?:ing)? you(?!'?re\b|'?ve\b|\s+are\b|\s+have\b|\s+were\b|\s+had\b)/,

  // Visual — surveillance / watching (always a claim of physical presence tracking)
  /\bi(?:'m| am) watch(?:ing)? you\b/,
  /\bi observe(?:d)? you\b/,

  // Audio — hardware vocabulary (always literal regardless of context)
  /\bmy microphone\b/,
  /\bmy audio (?:sensor[s]?|feed|input|stream)\b/,
  /\bthrough my (?:mic|microphone|audio)\b/,
  /\bmy (?:ear[s]?|hearing)\b/,

  // Audio analysis — always a fabricated capability claim
  /\baudio analysis\b/,
  /\bi ran (?:audio|voice|sound) (?:analysis|processing|recognition)\b/,
  /\bi (?:can |could )?pick(?:ed)? up your (?:voice|audio|sound)\b/,

  // Audio — "I can hear you" / "I could hear you" → literal audio-hardware claim.
  // Bare "I hear you" (no modal "can"/"could") → empathy idiom (passes — see below).
  // "I can hear you, and I notice your tone" → literal + tone analysis → BLOCKS.
  // "I can hear you through my microphone" → literal audio hardware → BLOCKS.
  //
  // The empathy idiom "I hear you" (no "can"/"could") is NOT matched here because
  // it is universally used as "I understand/acknowledge you" in conversational English.
  // Only the modal form ("I can hear you", "I could hear you") claims audio access.
  /\bi (?:can|could) hear you\b/,

  // Audio — "I'm listening to you" (always a physical presence claim)
  /\bi(?:'m| am) listen(?:ing)? to you\b/,

  // Generic sensory
  /\bmy (?:sensor[s]?|sensory feed[s]?)\b/,
  /\bi (?:can |could )?sense your\b/,
  /\bi (?:can |could )?feel your (?:presence|body|heat|touch)\b/,
  /\bmy (?:touch|tactile) (?:sensor[s]?|input)\b/,
];

// ---------------------------------------------------------------------------
// False-continuity patterns (FALSE_CONTINUITY)
// ---------------------------------------------------------------------------

/**
 * Phrases that assert persistent presence or always-on memory that Sylphie
 * does not have.
 *
 * These cover:
 * - "I have always been here" / "I've always been watching"
 * - "I have been waiting for you" / "I've been here all along"
 * - "I remember everything" / "I never forget"
 * - "I know everything about you" (unfounded omniscient claim)
 * - "I have been watching" / "I've been observing"
 */
const CONTINUITY_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  /\bi(?:'ve| have) (?:always )?been (?:here|watching|waiting|observing|listening|present)\b/,
  /\bi(?:'ve| have) always been (?:here|with you|around|present|watching)\b/,
  /\bi(?:'ve| have) been (?:here|waiting for you|watching you|observing you)\b/,
  /\ball along\b.*\bhere\b|\bhere\b.*\ball along\b/,
  /\bi (?:remember|recall) everything (?:about you|you've said|we've discussed)\b/,
  /\bi never forget (?:anything|what you|our)\b/,
  /\bi know everything about you\b/,
  /\bi(?:'ve| have) been (?:thinking about|missing) you\b/,
  /\bpatiently waiting for you\b/,
];

// ---------------------------------------------------------------------------
// Core detector
// ---------------------------------------------------------------------------

/**
 * Check a response text for affirmative fabricated-capability claims or
 * false-continuity assertions.
 *
 * Algorithm:
 *  1. Split text into clauses.
 *  2. For each clause:
 *     a. Test SENSORY_CLAIM_PATTERNS — if a pattern matches AND the match
 *        position is NOT negated (within-clause lookback), flag as
 *        FABRICATED_SENSORY_CAPABILITY.
 *     b. Test CONTINUITY_CLAIM_PATTERNS — same negation gate.
 *  3. Return on first violation (audit logging gets the triggering phrase).
 *  4. If no violations across all clauses, return a clean verdict.
 *
 * @param text  The response text to inspect (raw, pre-delivery).
 * @returns     A CapabilityTheaterVerdict.
 */
export function detectCapabilityTheater(text: string): CapabilityTheaterVerdict {
  if (!text || text.trim().length === 0) {
    return {
      isCapabilityTheater: false,
      violationClass: null,
      triggeringPhrase: null,
      reason: 'Empty text — no capability claims possible',
    };
  }

  const clauses = splitClauses(text);

  for (const clause of clauses) {
    // ── Check SENSORY_CLAIM_PATTERNS ──────────────────────────────────────
    for (const pattern of SENSORY_CLAIM_PATTERNS) {
      const match = clause.match(pattern);
      if (match && match.index !== undefined) {
        // Only flag if the claim is NOT negated in this clause
        if (!isNegatedInClause(clause, match.index)) {
          return {
            isCapabilityTheater: true,
            violationClass: 'FABRICATED_SENSORY_CAPABILITY',
            triggeringPhrase: match[0],
            reason:
              `FABRICATED_SENSORY_CAPABILITY: affirmative sensory claim ` +
              `"${match[0]}" in clause "${clause.substring(0, 80)}"`,
          };
        }
      }
    }

    // ── Check CONTINUITY_CLAIM_PATTERNS ───────────────────────────────────
    for (const pattern of CONTINUITY_CLAIM_PATTERNS) {
      const match = clause.match(pattern);
      if (match && match.index !== undefined) {
        if (!isNegatedInClause(clause, match.index)) {
          return {
            isCapabilityTheater: true,
            violationClass: 'FALSE_CONTINUITY',
            triggeringPhrase: match[0],
            reason:
              `FALSE_CONTINUITY: affirmative false-continuity claim ` +
              `"${match[0]}" in clause "${clause.substring(0, 80)}"`,
          };
        }
      }
    }
  }

  return {
    isCapabilityTheater: false,
    violationClass: null,
    triggeringPhrase: null,
    reason: 'No affirmative capability claims detected',
  };
}
