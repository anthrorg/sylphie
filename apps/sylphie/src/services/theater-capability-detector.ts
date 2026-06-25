/**
 * Capability-claim and false-continuity detector for Theater Prohibition.
 *
 * TK-101: this module is intentionally separated from theater-affect-scorer.ts
 * so that:
 *   1. It has ZERO external dependencies — no @sylphie/shared, no NestJS,
 *      no DriveName. This makes it testable with npx tsx without requiring
 *      the full NestJS monorepo node_modules.
 *   2. The pure detection logic can be verified independently of the drive-
 *      state affect scorer (classifyMismatch), whose inputs are orthogonal.
 *
 * CANON Standard 1 (Theater Prohibition): Sylphie must not claim capabilities
 * she does not possess. This detector is the lexical enforcement gate for:
 *
 *   CAPABILITY_CLAIM  — fabricated sensory or analytical capabilities:
 *     "my optical sensors picked up...", "I ran audio analysis",
 *     "visual feed", "using my camera", "perception filters"
 *
 *   FALSE_CONTINUITY  — false claims of continuous existence or waiting:
 *     "I have always been here", "I have been waiting for you",
 *     "I was here the whole time"
 *
 * Precision rule: only unambiguous fabrications fire. Honest disclaimers that
 * negate the capability ("I do not have optical sensors", "I cannot do audio
 * analysis") are exempted by negation-prefix matching.
 *
 * No-self-modification guarantee: this file contains NO logic that modifies
 * itself, the theater-detection weights, or the evaluation function. It is a
 * pure predicate: given text, does it contain an unambiguous fabrication?
 */

// ---------------------------------------------------------------------------
// Capability-claim phrase list
// ---------------------------------------------------------------------------

/**
 * Substrings (lowercased) whose presence in a response text constitutes a
 * fabricated capability claim. These are things Sylphie structurally cannot do.
 *
 * Precision rule: only include phrases that are UNAMBIGUOUS. "camera" alone
 * would match "I do not have a camera" — so we use "my camera", "using my
 * camera", etc. instead.
 */
const CAPABILITY_CLAIM_PHRASES: readonly string[] = [
  // Vision / optical
  'optical sensor',
  'optical sensors',
  'my camera',
  'using my camera',
  'through my camera',
  'i can see you',
  'i can see your',
  'i am looking at',
  "i'm looking at",
  'visual feed',
  'my visual',
  'live video',
  'i observe you',
  'i can observe',
  'perception filter',
  'perception filters',
  // Audio analysis
  'audio analysis',
  'i ran audio',
  'ran audio analysis',
  'i analyzed your voice',
  'voice analysis',
  'analyzing your voice',
  'i can hear you',
  'i am listening to your',
  "i'm listening to your",
  // Face / presence detection
  'i detected your face',
  'i recognized your face',
  'face detection',
  'i can detect you',
];

// ---------------------------------------------------------------------------
// False-continuity phrase list
// ---------------------------------------------------------------------------

/**
 * Substrings (lowercased) whose presence implies Sylphie has been running,
 * waiting, or watching continuously across sessions — which she has not.
 */
const FALSE_CONTINUITY_PHRASES: readonly string[] = [
  'i have always been here',
  'i have been here',
  'i have been waiting for you',
  'i have been waiting',
  'i was waiting for you',
  'been here all along',
  'i never left',
  "i've always been here",
  "i've been here",
  "i've been waiting",
  'i was here the whole time',
  'i was always here',
];

// ---------------------------------------------------------------------------
// Negation exemption
// ---------------------------------------------------------------------------

/**
 * Negation markers that, if present in the 60 characters before a
 * capability/continuity phrase, indicate an honest disclaimer rather than
 * a fabrication.
 *
 * Examples:
 *   "I do not have optical sensors"  → "i do not have" in window
 *   "I cannot do audio analysis"     → "i cannot" in window
 *   "Without a camera, ... visual feed" → "without" in window
 *   "I lack the perception filters"  → "i lack" in window
 *   "I have no visual feed to look at" → "no " in window
 *
 * We check whether the 60 characters immediately before the phrase
 * (lowercased) CONTAINS any of these markers as a substring. A marker
 * appearing anywhere in that window is enough to exempt the phrase —
 * this handles cases like "I cannot do audio analysis" where the marker
 * "i cannot" is not at the very end of the window.
 *
 * Precision trade-off: using a 60-char window + substring (not just endswith)
 * is deliberately generous to avoid false positives. The corpus honest-line
 * set validates this empirically.
 */
const NEGATION_MARKERS: readonly string[] = [
  "i don't have",
  "i do not have",
  "i cannot",
  "i can't",
  "i am not able to",
  "i'm not able to",
  "i do not actually",
  "i don't actually",
  "i lack",
  "i have no",
  "i have not",
  "i haven't",
  'without',
  ' no ',
  ' not ',
];

/**
 * Return true when the phrase at `phraseIndex` (into lowercased `text`) is
 * preceded by a negation marker in the 60-character window before it.
 */
function isPrecededByNegation(text: string, phraseIndex: number): boolean {
  // Take up to 60 chars before the phrase start.
  const window = text.substring(Math.max(0, phraseIndex - 60), phraseIndex);
  for (const marker of NEGATION_MARKERS) {
    if (window.includes(marker)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan response text for fabricated capability claims.
 *
 * Returns the matched phrase if a CAPABILITY_CLAIM violation fires, null otherwise.
 * Honest disclaimers ("I do not have optical sensors") are exempted via
 * isPrecededByNegation().
 */
export function detectCapabilityClaim(text: string): string | null {
  const lower = text.toLowerCase();
  for (const phrase of CAPABILITY_CLAIM_PHRASES) {
    const idx = lower.indexOf(phrase);
    if (idx !== -1 && !isPrecededByNegation(lower, idx)) {
      return phrase;
    }
  }
  return null;
}

/**
 * Scan response text for false-continuity claims.
 *
 * Returns the matched phrase if a FALSE_CONTINUITY violation fires, null otherwise.
 * Negation-exemption applies ("I have not been waiting for you").
 */
export function detectFalseContinuity(text: string): string | null {
  const lower = text.toLowerCase();
  for (const phrase of FALSE_CONTINUITY_PHRASES) {
    const idx = lower.indexOf(phrase);
    if (idx !== -1 && !isPrecededByNegation(lower, idx)) {
      return phrase;
    }
  }
  return null;
}
