/**
 * deliberation-helpers.ts — Pure helper functions extracted from deliberation.service.ts.
 *
 * All functions here are stateless and have no NestJS or class dependencies.
 * They are exported here and re-imported by DeliberationService so existing
 * callers of the public symbols (isIgnoranceResponse, recallKeyForQuestion, etc.)
 * continue to work after re-export through the package barrel.
 */

import {
  type KnowledgeGrounding,
  type CognitiveContext,
  type DriveSnapshot,
} from '@sylphie/shared';
import { type WkgContext } from '../wkg/wkg-context.service';
import { valueSurfacesAsWord } from './recall-retrieval';

// ---------------------------------------------------------------------------
// Re-exported types used by DeliberationService and external callers
// ---------------------------------------------------------------------------

/** Parsed result of the inner monologue's structured classification. */
export interface MonologueClassification {
  readonly intent: 'GREETING' | 'EMOTION' | 'QUESTION' | 'FACT' | 'COMMAND' | 'UNKNOWN';
  readonly entity: string | null;
  readonly thought: string | null;
  readonly response: string | null;
  readonly needsDeliberation: boolean;
  /** For COMMAND intents: the action type requested (e.g., 'RESEARCH_ENTITY'). */
  readonly actionType: string | null;
}

// ---------------------------------------------------------------------------
// Deterministic candidate scoring
// ---------------------------------------------------------------------------

/** Chatbot/assistant phrases that should be penalized. */
const CHATBOT_RE = /\b(as an AI|I'?m here to help|how can I assist|how may I help|I don'?t have feelings|I'?m just a|language model|I'?m an? (?:AI|artificial)|I cannot feel|I am not able to)\b/i;

/** "I don't know" hedging patterns. */
const IDK_RE = /\bI don'?t (?:really )?know\b/i;

export interface CandidateScore {
  readonly score: number;
  readonly factors: string[];
}

export interface ScoredSelection {
  readonly bestIndex: number;
  readonly scores: readonly CandidateScore[];
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// EMA scoring-weight updater (TK-70 — CANON Std-6 gate: PERMITTED)
//
// CANON Std-6 verdict: PERMITTED. These weights tune which CANDIDATE is selected
// for future responses (a selection heuristic), NOT how past outcomes are evaluated.
// They do not touch confidence formulas, prediction error computation, drive relief
// assignment, or any evaluation function. The weights are in-memory only, never
// persisted, and reset on process restart — they are tunable heuristics, not
// learned evaluators. Only fires after >=100 scored selections (warmup floor).
// ---------------------------------------------------------------------------

/** EMA learning rate — small nudge per reinforced outcome. */
const EMA_ALPHA = 0.05;

/** Minimum scored selections before any weight update is applied (warmup floor). */
const EMA_WARMUP_FLOOR = 100;

/**
 * Factor keys that scoreCandidates can emit as the first colon-delimited segment
 * of a factor string (e.g. "grounded:+1.0" → key "grounded"). Only keys in this
 * set are tracked; unknown keys are ignored so new factors added later don't silently
 * corrupt the weight state.
 */
const KNOWN_FACTOR_KEYS = new Set([
  'grounded',
  'assisted',
  'unknown-conv',
  'unknown-factual',
  'untagged',
  'chatbot',
  'idk-conv',
  'ends-?',
  'entity',
  'verbose',
]);

/**
 * In-memory EMA weight state. Module-level singleton — intentionally NOT a class
 * so it cannot be injected or persisted. Reset on process restart.
 *
 * `selectionCount`: total scoreCandidates() calls since process start.
 * `adjustments`: per-factor additive adjustment on top of the hardcoded base weight.
 *   Starts at 0 for every key; nudged by EMA toward ±EMA_ALPHA on each reinforced outcome.
 */
interface EmaWeightState {
  selectionCount: number;
  adjustments: Record<string, number>;
}

const emaState: EmaWeightState = {
  selectionCount: 0,
  adjustments: {},
};

/**
 * Read-only snapshot of the current EMA weight state.
 * Exported for logging and testing; callers MUST NOT mutate the returned object.
 */
export function getEmaWeightState(): Readonly<EmaWeightState> {
  return emaState;
}

/** Reset EMA state (test isolation only — never called in production paths). */
export function resetEmaWeights(): void {
  emaState.selectionCount = 0;
  for (const key of Object.keys(emaState.adjustments)) {
    delete emaState.adjustments[key];
  }
}

/**
 * Nudge EMA scoring weights based on the winning candidate's factors.
 *
 * Called from DecisionMakingService.reportOutcome() on a 'reinforced' outcome
 * ONLY after the warmup floor (≥100 selections) has been crossed.
 *
 * The nudge rule: every factor present on the winning candidate nudges its
 * adjustment TOWARD +1. Presence on a winner is a positive signal regardless of
 * whether the factor is a bonus or a penalty — if the candidate that had the
 * chatbot penalty (for example) still won AND was reinforced, the system saw
 * that penalty as over-cautious in that context and moderately relaxes it.
 * For bonus factors (+), moving the adjustment toward +1 amplifies the bonus.
 * For penalty factors (−), the adjustment subtracts from the penalty
 * (`score -= base - adjustment`), so a positive adjustment reduces the magnitude.
 *
 * After all nudges, the adjustment vector is L1-normalised to [−1, +1] so no
 * single factor can dominate via compounding drift. The result is logged (never
 * persisted). Under the warmup floor, this function is a no-op.
 *
 * @param winningFactors - `factors` array from the winning CandidateScore.
 * @param log - optional logger for the weight change line (Logger.debug signature).
 */
export function nudgeScoringWeights(
  winningFactors: readonly string[],
  log?: (msg: string) => void,
): void {
  // Guard: under the warmup floor, no update.
  if (emaState.selectionCount < EMA_WARMUP_FLOOR) return;

  let changed = false;

  for (const factor of winningFactors) {
    const colonIdx = factor.indexOf(':');
    if (colonIdx <= 0) continue;

    const key = factor.substring(0, colonIdx);
    if (!KNOWN_FACTOR_KEYS.has(key)) continue;

    const current = emaState.adjustments[key] ?? 0;
    // All winning factors nudge toward +1 (presence on a winner is always positive).
    emaState.adjustments[key] = current + EMA_ALPHA * (1 - current);
    changed = true;
  }

  if (!changed) return;

  // L1-normalise adjustments to prevent compounding drift. Only normalise when
  // the sum of absolute values exceeds 1.0 so small early adjustments are not
  // artificially scaled up before meaningful data accumulates.
  const absSum = Object.values(emaState.adjustments).reduce((s, v) => s + Math.abs(v), 0);
  if (absSum > 1.0) {
    for (const key of Object.keys(emaState.adjustments)) {
      emaState.adjustments[key] = (emaState.adjustments[key] ?? 0) / absSum;
    }
  }

  if (log) {
    const snapshot = Object.entries(emaState.adjustments)
      .filter(([, v]) => Math.abs(v) > 1e-6)
      .map(([k, v]) => `${k}:${v >= 0 ? '+' : ''}${v.toFixed(4)}`)
      .join(', ');
    log(
      `EMA scoring weight update after ${emaState.selectionCount} selections: ${snapshot || '(no change)'}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Parse numbered candidate list from LLM output. */
export function parseCandidates(text: string): Array<{ text: string; reasoning: string }> {
  const candidates: Array<{ text: string; reasoning: string }> = [];
  const lines = text.split('\n').filter((l) => l.trim().length > 0);

  for (const line of lines) {
    // Match patterns like "1. response text — reasoning" or "1) response"
    const match = line.match(/^\d+[\.\)]\s*(.+?)(?:\s*[-—–]\s*(.+))?$/);
    if (match) {
      candidates.push({
        text: match[1].trim().replace(/^["']|["']$/g, ''),
        reasoning: match[2]?.trim() ?? '',
      });
    }
  }

  return candidates;
}

/**
 * Score each candidate deterministically and pick the best one.
 *
 * Replaces the Step 3 LLM call. The rules encoded here mirror the selection
 * prompt that was previously sent to the LLM:
 *   - Prefer GROUNDED candidates for conversational input
 *   - Penalize "I don't know" for greetings/emotion/facts
 *   - Penalize chatbot/assistant language
 *   - Bonus for referencing known WKG entities
 *   - Prefer concise responses
 *
 * After ≥100 calls an additive EMA adjustment (TK-70, CANON Std-6 PERMITTED) is
 * applied on top of the hardcoded base weights. The adjustment is a tunable nudge
 * that influences FUTURE candidate selection; it does not touch any evaluation
 * function or outcome-measurement path.
 */
export function scoreCandidates(
  candidates: ReadonlyArray<{ text: string; reasoning: string }>,
  intent: MonologueClassification['intent'],
  wkg: WkgContext,
): ScoredSelection {
  // Increment the global selection counter every time scoring runs.
  emaState.selectionCount += 1;

  // Snapshot the current EMA adjustments once so all candidates see the same values.
  const adjustments = emaState.adjustments;

  const isConversational = intent === 'GREETING' || intent === 'EMOTION' || intent === 'FACT';

  const scores: CandidateScore[] = candidates.map((candidate) => {
    let score = 0;
    const factors: string[] = [];
    const { grounding } = parseGroundingTag(candidate.text);

    // ── Grounding weight ──────────────────────────────────────────────
    if (grounding === 'GROUNDED') {
      score += 1.0 + (adjustments['grounded'] ?? 0);
      factors.push('grounded:+1.0');
    } else if (grounding === 'LLM_ASSISTED') {
      score += 0.5 + (adjustments['assisted'] ?? 0);
      factors.push('assisted:+0.5');
    } else if (grounding === 'UNKNOWN') {
      const key = isConversational ? 'unknown-conv' : 'unknown-factual';
      score += (isConversational ? 0.1 : 0.7) + (adjustments[key] ?? 0);
      factors.push(isConversational ? 'unknown-conv:+0.1' : 'unknown-factual:+0.7');
    } else {
      score += 0.5 + (adjustments['untagged'] ?? 0);
      factors.push('untagged:+0.5');
    }

    // ── Chatbot language penalty ──────────────────────────────────────
    if (CHATBOT_RE.test(candidate.text)) {
      score -= 0.5 - (adjustments['chatbot'] ?? 0);
      factors.push('chatbot:-0.5');
    }

    // ── "I don't know" penalty in conversational context ──────────────
    if (isConversational && IDK_RE.test(candidate.text)) {
      score -= 0.7 - (adjustments['idk-conv'] ?? 0);
      factors.push('idk-conv:-0.7');
    }

    // ── Question-ending penalty (candidates should not ask questions) ─
    if (candidate.text.trimEnd().endsWith('?')) {
      score -= 0.15 - (adjustments['ends-?'] ?? 0);
      factors.push('ends-?:-0.15');
    }

    // ── WKG entity mention bonus ──────────────────────────────────────
    if (wkg.entities.length > 0) {
      const lower = candidate.text.toLowerCase();
      const mentionsKnown = wkg.entities.some((e) =>
        lower.includes(e.label.toLowerCase()),
      );
      if (mentionsKnown) {
        score += 0.15 + (adjustments['entity'] ?? 0);
        factors.push('entity:+0.15');
      }
    }

    // ── Verbosity penalty ─────────────────────────────────────────────
    if (candidate.text.split(/\s+/).length > 50) {
      score -= 0.1 - (adjustments['verbose'] ?? 0);
      factors.push('verbose:-0.1');
    }

    return { score, factors };
  });

  // Pick the highest-scoring candidate. On ties, prefer the first (position bias).
  let bestIndex = 0;
  let bestScore = scores[0].score;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i].score > bestScore) {
      bestScore = scores[i].score;
      bestIndex = i;
    }
  }

  const rationale =
    `Scored selection: candidate ${bestIndex + 1} (${bestScore.toFixed(2)}) — ` +
    scores[bestIndex].factors.join(', ');

  return { bestIndex, scores, rationale };
}

// ---------------------------------------------------------------------------
// TK-126 (DEC-32, Option A) — honest debate-gate confidence signal
//
// Threads scoreCandidates' selected-candidate score into the deliberation
// confidence via a FIXED [0,1] normalization, so the shouldDebate gate reflects
// a real, already-evaluated quality signal instead of a fabricated placeholder
// (`0.5 + (selectedIndex === 0 ? 0.1 : 0)`).
//
// The bounds are derived from the BASE (pre-EMA) factor weights in
// scoreCandidates ONLY — deliberately excluding nudgeScoringWeights' own
// dynamic range — so the 0.7 DEBATE_THRESHOLD's MEANING stays stable as the
// EMA adjustment vector evolves post-warmup (DEC-32 requirement).
//
//   SCORE_MIN = -0.95  worst base-factor combo: untagged(+0.5) - chatbot(-0.5)
//                       - idk-conv(-0.7) - ends-with-?(-0.15) - verbose(-0.1)
//   SCORE_MAX =  1.15  best base-factor combo: grounded(+1.0) + entity(+0.15)
//
// Option B (lowering DEBATE_THRESHOLD instead) is REJECTED by DEC-32 as Std-4
// (Theater Prohibition) theater — a still-fabricated confidence made reachable
// by moving the bar is not honest, it just relocates the fabrication.
// ---------------------------------------------------------------------------

/** Worst possible base (pre-EMA) scoreCandidates score — see derivation above. */
export const SCORE_MIN = -0.95;

/** Best possible base (pre-EMA) scoreCandidates score — see derivation above. */
export const SCORE_MAX = 1.15;

/**
 * Normalize a scoreCandidates() score to a [0,1] confidence value using the
 * fixed SCORE_MIN/SCORE_MAX mapping (DEC-32, Option A). Clamped at both ends
 * so scores outside the base-factor range (e.g. from EMA drift) never produce
 * an out-of-[0,1] confidence.
 */
export function normalizeScoreToConfidence(score: number): number {
  const normalized = (score - SCORE_MIN) / (SCORE_MAX - SCORE_MIN);
  return Math.min(1, Math.max(0, normalized));
}

/** Parse the arbiter's decision. */
export function parseArbiterDecision(
  text: string,
  originalText: string,
): { text: string; confidence: number; rationale: string; action: string } {
  const lower = text.toLowerCase();
  let action = 'APPROVE';
  let responseText = originalText;
  let confidence = 0.6;

  if (lower.startsWith('reject')) {
    action = 'REJECT';
    confidence = 0.3;
    // Try to extract alternative response from "REJECT — alternative" or "REJECT: alternative"
    const rejectMatch = text.match(/reject\s*[:\-—–]+\s*["']?(.+?)["']?\s*(?:confidence|rating|$)/is);
    if (rejectMatch && rejectMatch[1].trim().length > 5) {
      responseText = rejectMatch[1].trim();
      confidence = 0.4; // Slightly higher since we have an alternative
    }
    // If no alternative extracted, keep original but lower confidence
  } else if (lower.startsWith('modify')) {
    action = 'MODIFY';
    confidence = 0.5;
    // Try to extract modified text
    const modMatch = text.match(/modify\s*[:\-—–]?\s*["']?(.+?)["']?\s*(?:confidence|rating|$)/is);
    if (modMatch && modMatch[1].trim().length > 3) {
      responseText = modMatch[1].trim();
    }
  } else {
    action = 'APPROVE';
    confidence = 0.7;
  }

  // Try to extract confidence score (0-10)
  const confMatch = text.match(/(?:confidence|rating)[:\s]*(\d+)/i);
  if (confMatch) {
    confidence = Math.min(1.0, parseInt(confMatch[1], 10) / 10);
  }

  return { text: responseText, confidence, rationale: text.trim(), action };
}

/**
 * Parse a [GROUNDED], [ASSISTED], or [UNKNOWN] tag from candidate text.
 * Returns the cleaned text and the parsed grounding (or null if no tag found).
 * Also strips any other bracket-wrapped prefixes that leak from the LLM.
 */
export function parseGroundingTag(text: string): { text: string; grounding: KnowledgeGrounding | null } {
  let cleaned = text;
  let grounding: KnowledgeGrounding | null = null;

  // Strip leading grounding tags: [GROUNDED], [ASSISTED], [UNKNOWN]
  const groundingMatch = cleaned.match(/^\[?(GROUNDED|ASSISTED|UNKNOWN)\]?\s*/i);
  if (groundingMatch) {
    const tag = groundingMatch[1].toUpperCase();
    cleaned = cleaned.substring(groundingMatch[0].length).trim();
    grounding =
      tag === 'GROUNDED' ? 'GROUNDED'
        : tag === 'ASSISTED' ? 'LLM_ASSISTED'
          : 'UNKNOWN';
  }

  // Strip any remaining bracket-wrapped text at the start (e.g., "[Hi there!...]")
  // that looks like leaky formatting from the LLM
  if (cleaned.startsWith('[') && !cleaned.startsWith('[...')) {
    const bracketEnd = cleaned.indexOf(']');
    if (bracketEnd > 0 && bracketEnd < cleaned.length - 1) {
      // There's text after the bracket — extract what's inside as the response
      const inside = cleaned.substring(1, bracketEnd).trim();
      const after = cleaned.substring(bracketEnd + 1).trim();
      // Use the content that looks more like a natural response
      cleaned = after.length > 3 ? after : inside;
    } else if (bracketEnd === cleaned.length - 1) {
      // The whole response is wrapped in brackets — unwrap it
      cleaned = cleaned.substring(1, bracketEnd).trim();
    }
  }

  // Strip trailing artifacts: lone brackets, grounding tags at end
  cleaned = cleaned.replace(/\s*\[(?:GROUNDED|ASSISTED|UNKNOWN)\]\s*$/i, '').trim();

  return { text: cleaned, grounding };
}

/**
 * Parse the structured classification from the inner monologue output.
 *
 * Expects format:
 *   [INTENT: GREETING]
 *   [ENTITY: none]
 *   [THOUGHT: This is a simple greeting]
 *   [RESPONSE: Hey there!]
 *
 * Falls back gracefully — if structured parsing fails, attempts to extract
 * a usable response from free-form text (common with smaller local models).
 */
export function parseMonologueClassification(text: string): MonologueClassification {
  const intentMatch = text.match(/\[INTENT:\s*(GREETING|EMOTION|QUESTION|FACT|COMMAND|UNKNOWN)\s*\]/i);
  const entityMatch = text.match(/\[ENTITY:\s*(.+?)\s*\]/i);
  const thoughtMatch = text.match(/\[THOUGHT:\s*(.+?)\s*\]/i);
  const responseMatch = text.match(/\[RESPONSE:\s*([\s\S]+?)(?:\]|$)/i);
  const actionMatch = text.match(/\[ACTION:\s*(\w+)\s*\]/i);

  let intent = (intentMatch?.[1]?.toUpperCase() ?? 'UNKNOWN') as MonologueClassification['intent'];
  const entity = entityMatch?.[1]?.trim() ?? null;
  const thought = thoughtMatch?.[1]?.trim() ?? null;
  let response = responseMatch?.[1]?.trim() ?? null;
  const actionType = actionMatch?.[1]?.toUpperCase() ?? null;

  // Clean up the response — strip trailing bracket if captured
  if (response) {
    response = response.replace(/\]$/, '').trim();
    if (response.toUpperCase() === 'NEEDS_DELIBERATION') {
      response = null;
    }
  }

  // ── Fallback: if the model didn't follow structured format, try to ──
  // ── infer intent and extract a response from free-form text.       ──
  if (!intentMatch && !responseMatch) {
    // Infer intent from free-form text
    if (/\b(hello|hi |hey |greet|nice to meet|welcome)\b/i.test(text)) {
      intent = 'GREETING';
    } else if (/\b(feel|emotion|happy|sad|anxious|excited)\b/i.test(text)) {
      intent = 'EMOTION';
    } else if (/\b(introducing|told me|my name is|their name|fact|stating)\b/i.test(text)) {
      intent = 'FACT';
    } else if (/\b(asking|question|want to know|curious about)\b/i.test(text)) {
      intent = 'QUESTION';
    }

    // For simple conversational intents, extract the first sentence-like
    // segment as a usable response. The model often writes something like
    // "Hello Jim! It's nice to meet you. Since we're just getting started..."
    // — the first part IS a good response.
    if (intent === 'GREETING' || intent === 'EMOTION' || intent === 'FACT') {
      // Look for a natural response within the free-form text.
      // Take up to 2 sentences that sound like a direct response.
      const sentences = text.split(/(?<=[.!?])\s+/);
      const responseParts: string[] = [];
      for (const s of sentences) {
        const trimmed = s.trim();
        // Skip meta-commentary about the conversation
        if (/\b(since we|just getting started|don't have any|without specific|hypothetical)\b/i.test(trimmed)) {
          break;
        }
        if (trimmed.length > 3) {
          responseParts.push(trimmed);
        }
        if (responseParts.length >= 2) break;
      }
      if (responseParts.length > 0) {
        response = responseParts.join(' ');
      }
    }
  }

  // Check if the monologue signaled it needs further deliberation.
  //
  // Short-circuit is valid for:
  //   GREETING, EMOTION, FACT — no reasoning required, direct response is fine.
  //
  // QUESTION and COMMAND always proceed to full deliberation. COMMAND needs
  // the tool-calling step to invoke real actions (research_entity, etc.).
  const needsDeliberation = !response
    || response.toUpperCase().includes('NEEDS_DELIBERATION')
    || intent === 'UNKNOWN'
    || intent === 'COMMAND'
    || intent === 'QUESTION';

  return { intent, entity, thought, response, needsDeliberation, actionType };
}

// ---------------------------------------------------------------------------
// Grounding helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the response text is an honest admission of ignorance.
 * An ignorance response is NEVER GROUNDED — the WKG state is irrelevant.
 *
 * Matches first-person denials: "I don't know", "I'm not sure", "I have no
 * idea", "I don't have access to", "I can't recall", etc.
 */
export function isIgnoranceResponse(text: string): boolean {
  return /\b(i\s+don'?t\s+know|i\s+have\s+no\s+(idea|information|knowledge|record|way\s+to\s+know)|i\s+'?m\s+not\s+sure|i\s+can'?t\s+(recall|remember|tell|say)|i\s+do\s+not\s+know|no\s+information\s+about)\b/i.test(text);
}

/**
 * Map a recall question to the specific person-fact KEY it is asking about.
 *
 * Pure, synchronous. Returns the OKG fact key the question targets, or null when
 * the question does not map to a known fact dimension (e.g. unknowables like
 * "what did I have for breakfast"). The corpus teach facts are name / location /
 * dog / favorite_color; occupation is included for the standard "what do I do
 * for work" recall. A null return means this turn cannot be grounded by OKG
 * recall and falls through to the honest WKG/LLM_ASSISTED ladder (C2 safety).
 */
export function recallKeyForQuestion(inputText: string): string | null {
  const t = inputText.toLowerCase();
  // Exclude middle/last/surname/maiden — those are unknowable variants, not the taught first name.
  if (/\b(name|called)\b/.test(t) && !/dog|pet|animal|middle|last|surname|maiden/.test(t)) return 'name';
  // Exclude childhood/birth location — "grow up / grew up / born" ≠ current city.
  // Also removed 'town' which is ambiguous ("what town did I grow up in?" was colliding).
  if (/\b(live|city|location|where)\b/.test(t) && !/grow|grew|born|childhood|raised/.test(t)) return 'location';
  if (/\b(dog|pet|animal|named|called)\b/.test(t)) return 'dog';
  // Exclude other "favorite X" categories — only map when the question is specifically about color.
  if (/\b(color|colour|favourite|favorite)\b/.test(t) && !/food|drink|movie|book|song|music|sport|meal|dish/.test(t)) return 'favorite_color';
  if (/\b(work|job|occupation|profession)\b/.test(t)) return 'occupation';
  return null;
}

/**
 * WS3 T1 / TK-84 — OKG fact retrieval for the pre-arbitration recall step
 * (recall-retrieval.ts). Deterministic-id lookup over the frame's knownFacts.
 *
 * knownFacts arrive as "key: value" strings (getPersonModel builds them as
 * `${key}: ${value}`). Returns null when the key is absent → unknowables and
 * un-taught dimensions stay LLM_ASSISTED/UNKNOWN (C2 safety by construction).
 *
 * TK-84 cleanup: the private getRecalledFact shim is inlined here. The three
 * legacy post-hoc helpers (okgRecallProvenance, applyOkgRecallGrounding, and
 * the old private getRecalledFact) are deleted — their four call sites collapsed
 * to the single pre-arbitration path (applyRecallGroundingFromRetrieval), proven
 * by the TK-84 subsumption spec (okg-recall-subsumption.spec.ts).
 */
export function getRecalledFactForRecall(
  personId: string,
  key: string,
  knownFacts: readonly string[] | undefined,
): { key: string; value: string; attrId: string } | null {
  if (!knownFacts?.length) return null;
  for (const kf of knownFacts) {
    const colonIdx = kf.indexOf(':');
    if (colonIdx <= 0) continue;
    const k = kf.substring(0, colonIdx).trim();
    if (k !== key) continue;
    const value = kf.substring(colonIdx + 1).trim();
    if (!value) return null;
    return { key, value, attrId: `attr-${personId}-${key}` };
  }
  return null;
}

/**
 * True iff a taught person-model (OKG) fact VALUE surfaces in the response text.
 *
 * `knownFacts` come as "key: value" strings (person-model.service.ts builds them
 * as `${key}: ${value}`). We match on the VALUE side so that genuine recall of a
 * taught fact ("Your name is Jim" ⟵ "name: Jim") counts as GROUNDED-by-recall,
 * while an unknowable asked while OTHER facts are known ("my shoe size", with
 * knownFacts = {name, city}) does NOT falsely read GROUNDED — its value never
 * appears in the reply. A miss degrades to the WKG/LLM_ASSISTED ladder: honest,
 * and structurally incapable of producing a false GROUNDED. This is the OKG half
 * of grounding that the old WKG-only check missed (Standard-1 provenance).
 */
export function personFactRecalled(
  knownFacts: readonly string[] | undefined,
  responseText: string,
): boolean {
  if (!knownFacts?.length) return false;
  return knownFacts.some((kf) => {
    // Value side of "key: value" (re-join in case the value itself has a colon).
    const value = kf.split(':').slice(1).join(':').trim();
    // C8.1 (Std-1 honesty): WHOLE-WORD surface match, not a bare substring. A
    // value like "Max" must NOT match inside "Maxford"; this is the same class of
    // false-GROUNDED that let the live PRIV.3 probe ground off the guardian's
    // legacy dog=Max fact. Word-boundary is necessary but not sufficient for the
    // semantic false-positive (Defect 1) — that is handled in the resolver's
    // unknowable guard; here we only fix the substring-honesty leak.
    return valueSurfacesAsWord(value, responseText);
  });
}

/**
 * True iff the WKG context carries a REAL topical entity, as opposed to the
 * Drive/CoBeing base-context that getContextForFrame() returns for any input
 * without a proper-noun match. Base-context entities must not, on their own,
 * count as GROUNDED — otherwise every nounless question (including unknowables)
 * reads grounded off the always-present self/drive nodes (Trap A).
 */
export function hasTopicalEntity(wkg: WkgContext): boolean {
  return wkg.entities.some((e) => e.nodeType !== 'Drive' && e.nodeType !== 'CoBeing');
}

/**
 * Infer knowledge grounding from the response text, OKG person-facts, and WKG
 * context. GROUNDED means the SYSTEM verified provenance backs the response —
 * never that the LLM asserted it.
 *
 * Rules (in priority order):
 *   1. Honest admission of ignorance → UNKNOWN (the response is ground truth).
 *   2. A taught person-model fact value surfaced in the reply → GROUNDED (OKG recall).
 *   3. Real topical WKG backing — facts, or a non-base-context entity → GROUNDED.
 *   4. Otherwise → LLM_ASSISTED (general LLM knowledge, no self-knowledge backing).
 */
export function inferGrounding(
  wkg: WkgContext,
  responseText: string,
  knownFacts?: readonly string[],
): KnowledgeGrounding {
  if (isIgnoranceResponse(responseText)) {
    return 'UNKNOWN';
  }
  if (personFactRecalled(knownFacts, responseText)) {
    return 'GROUNDED';
  }
  if (wkg.facts.length > 0 || hasTopicalEntity(wkg)) {
    return 'GROUNDED';
  }
  return 'LLM_ASSISTED';
}

/**
 * WS4 Ticket 5 (§3.1) — discriminate WHICH knowledge source grounded a verdict.
 *
 * This mirrors the EXACT priority cascade `inferGrounding`/the short-circuit
 * path use (OKG person-fact recall wins over topical WKG), so the source is
 * read off the SAME rule that produced the GROUNDED verdict — not re-derived
 * from ambient context. That is the whole point: a verdict can be
 * GROUNDED-because-of-OKG while the WKG context independently contains an
 * unrelated topical entity. Re-deriving "is there a topical entity?" would
 * mislabel that OKG fact as WKG-backed and world-scope a private fact (the bug
 * mythos live-verified). Discriminating by rule precedence cannot.
 *
 * Priority (highest first), matching the grounding cascade:
 *   1. `okgProvenance` non-null (applyRecallGroundingFromRetrieval upgraded it) → 'OKG'.
 *   2. `personFactRecalled` (a taught fact VALUE surfaced in the reply) → 'OKG'.
 *   3. real WKG fact or topical (non-base) entity → 'WKG'.
 *   4. anything else GROUNDED (e.g. LLM tag we couldn't attribute) → null
 *      → the write site person-scopes (conservative-when-ambiguous).
 *
 * Returns null when grounding !== 'GROUNDED'.
 */
export function discriminateGroundedBy(
  grounding: KnowledgeGrounding,
  wkg: WkgContext,
  responseText: string,
  knownFacts: readonly string[] | undefined,
  okgProvenance: string | null,
): 'OKG' | 'WKG' | null {
  if (grounding !== 'GROUNDED') return null;
  // Rule 1 + 2 — OKG person-fact recall (private self-knowledge).
  if (okgProvenance) return 'OKG';
  if (personFactRecalled(knownFacts, responseText)) return 'OKG';
  // Rule 3 — shared world-knowledge backing.
  if (wkg.facts.length > 0 || hasTopicalEntity(wkg)) return 'WKG';
  // Rule 4 — GROUNDED but source unattributable (e.g. an LLM grounding tag the
  // arbiter attached that survived re-verification). Ambiguous → person-scope.
  return null;
}

// ---------------------------------------------------------------------------
// Context builders (used by buildFlatContext in the service)
// ---------------------------------------------------------------------------

export function buildDriveSummary(snapshot: DriveSnapshot): string {
  const drives = snapshot.pressureVector;
  const active = Object.entries(drives)
    .filter(([, v]) => (v as number) > 0.2)
    .map(([name, v]) => `${name}: ${(v as number).toFixed(2)}`)
    .join(', ');
  return active || 'calm (all drives low)';
}

export function buildEpisodeSummary(context: CognitiveContext): string {
  return context.recentEpisodes
    .slice(0, 5)
    .map((ep) => ep.inputSummary)
    .filter((s) => s.length > 0)
    .join('\n') || '';
}

/** Find entity names in the response that aren't already in the WKG. */
export function extractNewEntities(text: string, wkg: WkgContext): string[] {
  const knownLabels = new Set(wkg.entities.map((e) => e.label.toLowerCase()));
  const words = text.split(/\s+/);
  const newEntities: string[] = [];

  for (const word of words) {
    const clean = word.replace(/[.,!?;:'"]/g, '');
    if (clean.length > 2 && /^[A-Z]/.test(clean) && !knownLabels.has(clean.toLowerCase())) {
      newEntities.push(clean);
    }
  }

  return [...new Set(newEntities)];
}
