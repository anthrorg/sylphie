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

/** One captured composed-prompt observation (size-1 ring). */
export interface CapturedPrompt {
  /** The composed visual/knowledge context summary the LLM prompt embedded. */
  contextSummary: string;
  /** Which path composed it (production WM-snapshot vs flat fallback). */
  compositionPath: PromptCompositionPath;
  /** Raw user text of the turn (for correlating the capture with the probe). */
  userText: string;
  /** Wall-clock capture time. */
  at: string;
}

let lastCaptured: CapturedPrompt | null = null;

/**
 * Record the composed context summary for the current deliberation turn. No-op
 * unless GATE_DEBUG_PROMPT_CAPTURE is set, so production stays dark.
 */
export function capturePrompt(
  contextSummary: string,
  compositionPath: PromptCompositionPath,
  userText: string,
): void {
  if (!isPromptCaptureEnabled()) return;
  lastCaptured = {
    contextSummary,
    compositionPath,
    userText,
    at: new Date().toISOString(),
  };
}

/** Read the last captured composed prompt (or null if none / capture disabled). */
export function getLastCapturedPrompt(): CapturedPrompt | null {
  return lastCaptured;
}

/** Clear the ring (gate hermeticity between phases). */
export function resetPromptCapture(): void {
  lastCaptured = null;
}
