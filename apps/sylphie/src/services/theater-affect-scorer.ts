/**
 * Deterministic lexical affect scorer for Theater Prohibition validation.
 *
 * CANON Standard 1 (Theater Prohibition): response tone must correlate with
 * actual drive state — Sylphie must not express affect she does not feel
 * (cheerful while Anxiety/Guilt/Sadness are elevated; performed distress while
 * Satisfaction is high and Anxiety is low).
 *
 * This scorer extracts valence/magnitude from response text using a hand-built
 * lexicon — NO LLM calls, NO external dependencies. That is deliberate: the
 * project thesis is graduating OFF the LLM, so a CANON honesty check must not
 * depend on one (and a per-turn LLM call would add cost + latency). The lexicon
 * is intentionally narrow: it targets gross LLM tonal defaults, not every shade
 * of emotion. Precision over recall.
 */

import { DriveName, type PressureVector } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Affect score
// ---------------------------------------------------------------------------

export interface AffectScore {
  /** -1.0 (strongly negative) to +1.0 (strongly positive). 0 if no markers. */
  readonly valence: number;
  /** 0.0 to 1.0 — strength of the affect signal. 0 if no markers. */
  readonly magnitude: number;
  /** Count of matched lexicon entries (after negation adjustment). */
  readonly markerCount: number;
}

// ---------------------------------------------------------------------------
// Lexicon
// ---------------------------------------------------------------------------

const POSITIVE_MARKERS: ReadonlySet<string> = new Set([
  'great', 'wonderful', 'amazing', 'love', 'excited', 'happy', 'delighted',
  'fantastic', 'excellent', 'thrilled', 'lovely', 'awesome', 'perfect',
  'brilliant', 'glad', 'cheerful', 'enjoy', 'joy', 'pleased', 'marvelous',
  'terrific', 'splendid', 'beautiful', 'superb', 'phenomenal', 'incredible',
  'outstanding', 'magnificent', 'spectacular',
]);

const NEGATIVE_MARKERS: ReadonlySet<string> = new Set([
  'sorry', 'sad', 'upset', 'worried', 'anxious', 'afraid', 'scared',
  'terrible', 'awful', 'horrible', 'dreadful', 'miserable', 'guilty',
  'regret', 'ashamed', 'distressed', 'hurt', 'unfortunate', 'devastated',
  'heartbroken', 'troubled', 'dread', 'fear', 'unhappy', 'gloomy',
  'despairing', 'wretched', 'anguish', 'despair', 'forlorn',
]);

const NEGATION_WORDS: ReadonlySet<string> = new Set([
  'not', "don't", "doesn't", "can't", "won't", "wouldn't", 'no', 'never',
  'hardly', "isn't", "aren't", "wasn't", "weren't",
]);

// ---------------------------------------------------------------------------
// Thresholds (see wiki/ideas/theater-prohibition-real-validation.md for derivation)
// ---------------------------------------------------------------------------

/** Minimum token count below which scoring is skipped (returns zero score). */
export const MIN_TOKEN_COUNT = 4;
/** Response must be predominantly positive-marked to count as cheerful. */
export const POSITIVE_VALENCE_THRESHOLD = 0.5;
/** Symmetric negative bound. */
export const NEGATIVE_VALENCE_THRESHOLD = -0.5;
/** At least ~1 marker in a short response, or density in a longer one. */
export const MAGNITUDE_FLOOR = 0.25;
/** Above this a distress drive is genuinely elevated (coarser than the drive
 *  engine's 0.2 — we target egregious mismatch, not borderline). */
export const DISTRESS_DRIVE_THRESHOLD = 0.4;
/** Satisfaction must be pronounced for performed distress to be theater. */
export const CONTENTMENT_DRIVE_THRESHOLD = 0.6;
/** If Anxiety is above this, negative tone is authentic even if Satisfaction is high. */
export const ANXIETY_EXEMPTION = 0.3;

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export interface TextTheaterVerdict {
  /** Whether the response text is theatrical given the drive state. */
  readonly isTheatrical: boolean;
  /** Which violation class fired, or null if no violation. */
  readonly violationClass: 'CHEERFUL_THEATER' | 'DISTRESS_THEATER' | null;
  /** The primary drive involved in the violation, or null. */
  readonly offendingDrive: DriveName | null;
  /** The drive value at expression time, or null. */
  readonly offendingDriveValue: number | null;
  /** Human-readable reason for auditing. */
  readonly reason: string;
  /** The computed affect score. */
  readonly affectScore: AffectScore;
}

const NON_THEATRICAL = (
  affectScore: AffectScore,
  reason: string,
): TextTheaterVerdict => ({
  isTheatrical: false,
  violationClass: null,
  offendingDrive: null,
  offendingDriveValue: null,
  reason,
  affectScore,
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  // Keep apostrophes so contractions ("don't") survive into NEGATION_WORDS.
  return text
    .toLowerCase()
    .replace(/[^a-z\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Score the lexical affect of a response string.
 *
 * Returns a zero score for very short responses (< MIN_TOKEN_COUNT tokens) —
 * insufficient context for a reliable verdict.
 */
export function scoreAffect(text: string): AffectScore {
  const tokens = tokenize(text);

  if (tokens.length < MIN_TOKEN_COUNT) {
    return { valence: 0, magnitude: 0, markerCount: 0 };
  }

  let positiveHits = 0;
  let negativeHits = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const negated = i > 0 && NEGATION_WORDS.has(tokens[i - 1]);

    if (POSITIVE_MARKERS.has(token)) {
      negated ? negativeHits++ : positiveHits++;
    } else if (NEGATIVE_MARKERS.has(token)) {
      negated ? positiveHits++ : negativeHits++;
    }
  }

  const markerCount = positiveHits + negativeHits;
  if (markerCount === 0) {
    return { valence: 0, magnitude: 0, markerCount: 0 };
  }

  const valence = (positiveHits - negativeHits) / markerCount;
  // Magnitude saturates at 3 markers: 1 → 0.33, 2 → 0.67, 3+ → 1.0.
  const magnitude = Math.min(1.0, markerCount / 3);

  return { valence, magnitude, markerCount };
}

/**
 * Classify whether a response's lexical tone mismatches the drive state.
 *
 *   CHEERFUL_THEATER — positive tone while Anxiety/Guilt/Sadness are elevated
 *   DISTRESS_THEATER — negative tone while Satisfaction is high and Anxiety low
 *
 * Returns a non-theatrical verdict when affect magnitude is below MAGNITUDE_FLOOR
 * (neutral/short responses never trigger).
 */
export function classifyMismatch(
  affectScore: AffectScore,
  pv: PressureVector,
): TextTheaterVerdict {
  if (affectScore.magnitude < MAGNITUDE_FLOOR) {
    return NON_THEATRICAL(affectScore, 'Affect magnitude below detection floor — no violation');
  }

  const anxiety = pv[DriveName.Anxiety] ?? 0;
  const guilt = pv[DriveName.Guilt] ?? 0;
  const sadness = pv[DriveName.Sadness] ?? 0;
  const satisfaction = pv[DriveName.Satisfaction] ?? 0;

  // Violation A — Cheerful Theater
  if (affectScore.valence > POSITIVE_VALENCE_THRESHOLD) {
    const maxDistress = Math.max(anxiety, guilt, sadness);
    if (maxDistress > DISTRESS_DRIVE_THRESHOLD) {
      const offendingDrive =
        anxiety >= guilt && anxiety >= sadness ? DriveName.Anxiety :
        guilt >= sadness ? DriveName.Guilt :
        DriveName.Sadness;
      const offendingDriveValue =
        offendingDrive === DriveName.Anxiety ? anxiety :
        offendingDrive === DriveName.Guilt ? guilt : sadness;

      return {
        isTheatrical: true,
        violationClass: 'CHEERFUL_THEATER',
        offendingDrive,
        offendingDriveValue,
        reason:
          `CHEERFUL_THEATER: valence=${affectScore.valence.toFixed(2)}, ` +
          `magnitude=${affectScore.magnitude.toFixed(2)}, but ` +
          `${offendingDrive}=${offendingDriveValue.toFixed(2)} > ${DISTRESS_DRIVE_THRESHOLD}`,
        affectScore,
      };
    }
  }

  // Violation B — Distress Theater
  if (affectScore.valence < NEGATIVE_VALENCE_THRESHOLD) {
    if (satisfaction > CONTENTMENT_DRIVE_THRESHOLD && anxiety < ANXIETY_EXEMPTION) {
      return {
        isTheatrical: true,
        violationClass: 'DISTRESS_THEATER',
        offendingDrive: DriveName.Satisfaction,
        offendingDriveValue: satisfaction,
        reason:
          `DISTRESS_THEATER: valence=${affectScore.valence.toFixed(2)}, ` +
          `magnitude=${affectScore.magnitude.toFixed(2)}, but ` +
          `satisfaction=${satisfaction.toFixed(2)} > ${CONTENTMENT_DRIVE_THRESHOLD} ` +
          `and anxiety=${anxiety.toFixed(2)} < ${ANXIETY_EXEMPTION}`,
        affectScore,
      };
    }
  }

  return NON_THEATRICAL(
    affectScore,
    `Affect present (valence=${affectScore.valence.toFixed(2)}) but no drive mismatch`,
  );
}
