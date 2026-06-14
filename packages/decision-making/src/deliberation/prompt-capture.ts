/**
 * prompt-capture.ts — WS5 T4 (P2/P4) test-only "last composed prompt" mirror.
 *
 * The anti-theater claim P2/P4 must prove is: the injected perception caption is
 * GENUINELY in the prompt the LLM saw — not that the response merely happened to
 * mention the noun. The cassette TapeEntry.key was the original proxy for "the
 * composed prompt" (the cassette hashes the full prompt), but coupling P2/P4 to
 * cassette record/replay is structurally brittle: the perception prompt embeds a
 * VWM-derived scene description + scene-change-nudge turns whose exact bytes drift
 * run-to-run, so a recorded tape can HIT-while-stale and assert on a key that no
 * longer reflects what the backend built (the theater hole reopening from the
 * other side). mythos ruling (2026-06-13): read the REAL composed prompt directly.
 *
 * This module is that read surface: the deliberation service writes the composed
 * visual-context summary (the `wmSummary` that carries "What I see:" / "What I
 * know:") plus a one-word path tag into a size-1 ring; the gate's P2/P4 smoke
 * reads it via GET /api/metrics/last-deliberation-prompt and asserts
 * normalize(prompt).includes(normalize(caption)) AND that the WM-snapshot path
 * (production), not the flat fallback, fired.
 *
 * CANON discipline (mythos constraints):
 *   1. TEST-ONLY activation — the ring is populated ONLY when the
 *      GATE_DEBUG_PROMPT_CAPTURE env flag is set. In normal operation it is dark:
 *      a standing "last prompt sent to the LLM" surface would be a data-exfil seam
 *      over content that includes person facts + drive state.
 *   2. MIRROR, not a hook — it records what was already composed; it is never read
 *      by, and never feeds back into, any cognitive path. Observes the boundary's
 *      input; it does not become one.
 *   3. NO provenance laundering — debug telemetry only. Carries no provenance tier
 *      and never re-enters episodic/WKG. Write-to-ring, read-by-test, dropped.
 */

/** True iff prompt capture is enabled (test-only env flag). */
export function isPromptCaptureEnabled(): boolean {
  return process.env.GATE_DEBUG_PROMPT_CAPTURE === '1' ||
    process.env.GATE_DEBUG_PROMPT_CAPTURE === 'true';
}

/**
 * Which composition path produced the captured visual-context summary.
 * - wm-snapshot          : deliberate() production WM-snapshot path
 * - flat-fallback        : deliberate() fallback when WorkingMemoryService is null
 * - procedure-llm-generate: the LLM_GENERATE action-handler (conversation
 *   procedure) path — the path arbitration runs for a visual question, which
 *   bypasses deliberate(); WS5 P2 asserts the caption reached THIS prompt.
 */
export type PromptCompositionPath =
  | 'wm-snapshot'
  | 'flat-fallback'
  | 'procedure-llm-generate'
  | 'none';

/** One captured composed-prompt observation. */
export interface CapturedPrompt {
  /** The composed visual/knowledge context summary the LLM prompt embedded. */
  contextSummary: string;
  /** Which path composed it (production WM-snapshot vs flat fallback). */
  compositionPath: PromptCompositionPath;
  /** Raw user text of the turn (for correlating the capture with the probe). */
  userText: string;
  /**
   * The turnId of the cycle that composed this prompt, when known.
   *
   * WS5 T4/P2 (turn-correlation): the smoke reads the prompt for the SPECIFIC
   * "what do you see?" turn it sent (by the turnId echoed on that turn's
   * cb_speech), not the "latest" capture. Under queue backlog the real procedure
   * cycle can compose its prompt seconds after the probe returns on an earlier
   * cb_speech, so a fixed-delay "latest" read could observe the wrong turn's
   * (empty) capture. Keying captures by turnId lets the test poll for THIS turn's
   * record specifically. `null` for self-ticks / scene-nudges (no human turnId).
   */
  turnId: string | null;
  /** Wall-clock capture time. */
  at: string;
}

/**
 * Most-recent capture (backward-compatible "latest" read). Retained so the
 * existing GET /metrics/last-deliberation-prompt (no turnId) keeps working.
 */
let lastCaptured: CapturedPrompt | null = null;

/**
 * Bounded turnId-keyed buffer of recent captures, newest last. A small ring
 * (not size-1) so a stale earlier turn's capture cannot mask the target turn's,
 * and so the target turn's capture is still findable when it lands AFTER the
 * probe returned (queue-backlog correlation). Test-only; never read by any
 * cognitive path.
 */
const byTurnId = new Map<string, CapturedPrompt>();
const RING_CAP = 16;

/**
 * Record the composed context summary for the current deliberation turn. No-op
 * unless GATE_DEBUG_PROMPT_CAPTURE is set, so production stays dark.
 *
 * @param turnId - turnId of the composing cycle, or null/undefined for
 *   originator-less cycles (self-tick / scene-nudge). When present, the capture
 *   is also indexed by turnId for turn-correlated reads.
 */
export function capturePrompt(
  contextSummary: string,
  compositionPath: PromptCompositionPath,
  userText: string,
  turnId?: string | null,
): void {
  if (!isPromptCaptureEnabled()) return;
  const record: CapturedPrompt = {
    contextSummary,
    compositionPath,
    userText,
    turnId: turnId ?? null,
    at: new Date().toISOString(),
  };
  lastCaptured = record;
  if (record.turnId) {
    byTurnId.set(record.turnId, record);
    // Bound the ring — evict oldest insertions beyond the cap.
    while (byTurnId.size > RING_CAP) {
      const oldest = byTurnId.keys().next().value;
      if (oldest === undefined) break;
      byTurnId.delete(oldest);
    }
  }
}

/** Read the last captured composed prompt (or null if none / capture disabled). */
export function getLastCapturedPrompt(): CapturedPrompt | null {
  return lastCaptured;
}

/**
 * Read the captured composed prompt for a SPECIFIC turnId, or null if none has
 * been recorded for that turn yet. The turn-correlated read P2 polls on.
 */
export function getCapturedPromptForTurn(turnId: string): CapturedPrompt | null {
  return byTurnId.get(turnId) ?? null;
}

/** Clear the ring (gate hermeticity between phases). */
export function resetPromptCapture(): void {
  lastCaptured = null;
  byTurnId.clear();
}
