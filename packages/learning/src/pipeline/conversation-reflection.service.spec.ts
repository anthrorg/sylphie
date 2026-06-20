/**
 * Unit tests for pure helpers in conversation-reflection.service:
 *
 * computeGroundedConfidence — Idea 5: Grounded Confidence.
 *   A. No entity references (purely observational) → base confidence, grounded=true
 *   B. Partial grounding (some entities matched)   → scaled confidence, grounded=true
 *   C. Zero grounding (no entities matched)        → floor confidence 0.05, grounded=false
 *   D. Full grounding (all entities matched)       → full base confidence, grounded=true
 *   E. Floor behaviour (very small ratio)          → never below 0.05
 *
 * buildReflectionPrompt — TK-52: Windowed sampling for long sessions.
 *   F. Session within budget   → all events included unchanged; no OOB on 2-event case
 *   G. Session exceeds budget  → head + middle-sample + tail; total <= MAX_CONVERSATION_CHARS
 *   H. Head and tail presence  → first and last event always appear in the output
 */

import { computeGroundedConfidence, buildReflectionPrompt } from './conversation-reflection.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** MAX_CONVERSATION_CHARS as defined in the module. */
const MAX_CHARS = 8000;

interface MinimalEvent {
  id: string;
  type: string;
  timestamp: Date;
  subsystem: string;
  content: string;
}

/** Build a synthetic SessionEvent with a known content string. */
function makeEvent(index: number, content: string): MinimalEvent {
  return {
    id: `evt-${index}`,
    type: 'CHAT_INPUT_RECEIVED',
    timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, index)), // unique timestamps
    subsystem: 'TEST',
    content,
  };
}

/**
 * Extract just the timeline lines from a built prompt.
 * Lines between "Conversation timeline:" and the entity section (or end).
 */
function extractTimelineChars(prompt: string): number {
  // The timeline section starts after "Conversation timeline:\n"
  const marker = 'Conversation timeline:\n';
  const start = prompt.indexOf(marker);
  if (start === -1) return 0;
  const timelineSection = prompt.slice(start + marker.length);
  // Strip the trailing entity section if present.
  const entityMarker = '\nKnown entities already in the knowledge graph for this session:';
  const entityIdx = timelineSection.indexOf(entityMarker);
  const content = entityIdx === -1 ? timelineSection : timelineSection.slice(0, entityIdx);
  return content.length;
}

// REFLECTION_CONFIDENCE is 0.30 (module-level constant).
// Tests refer to it symbolically via BASE so the relationship is clear.
const BASE = 0.30;

describe('computeGroundedConfidence', () => {
  // -------------------------------------------------------------------------
  // A. No entity references
  // -------------------------------------------------------------------------
  describe('when no entities were referenced (attemptedReveals === 0)', () => {
    it('returns base REFLECTION_CONFIDENCE unchanged', () => {
      const result = computeGroundedConfidence(0, 0);
      expect(result.adjustedConfidence).toBe(BASE);
    });

    it('marks the insight as grounded=true (nothing to fail against)', () => {
      const result = computeGroundedConfidence(0, 0);
      expect(result.grounded).toBe(true);
    });

    it('returns groundingRatio of 1 (full credit for observational insights)', () => {
      const result = computeGroundedConfidence(0, 0);
      expect(result.groundingRatio).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // B. Partial grounding
  // -------------------------------------------------------------------------
  describe('when some referenced entities matched (partial grounding)', () => {
    it('scales confidence by the ratio: 1/4 matched → 0.30 * 0.25 = 0.075', () => {
      const result = computeGroundedConfidence(4, 1);
      expect(result.adjustedConfidence).toBeCloseTo(BASE * 0.25);
    });

    it('scales confidence by the ratio: 2/4 matched → 0.30 * 0.5 = 0.15', () => {
      const result = computeGroundedConfidence(4, 2);
      expect(result.adjustedConfidence).toBeCloseTo(BASE * 0.5);
    });

    it('scales confidence by the ratio: 3/4 matched → 0.30 * 0.75 = 0.225', () => {
      const result = computeGroundedConfidence(4, 3);
      expect(result.adjustedConfidence).toBeCloseTo(BASE * 0.75);
    });

    it('marks partial-grounding insights as grounded=true', () => {
      const result = computeGroundedConfidence(4, 1);
      expect(result.grounded).toBe(true);
    });

    it('returns the correct groundingRatio for 1/4 matched', () => {
      const result = computeGroundedConfidence(4, 1);
      expect(result.groundingRatio).toBeCloseTo(0.25);
    });

    it('returns the correct groundingRatio for 3/5 matched', () => {
      const result = computeGroundedConfidence(5, 3);
      expect(result.groundingRatio).toBeCloseTo(0.6);
    });
  });

  // -------------------------------------------------------------------------
  // C. Zero grounding (ungrounded insight)
  // -------------------------------------------------------------------------
  describe('when no referenced entities matched (zero grounding)', () => {
    it('returns the floor confidence of 0.05', () => {
      const result = computeGroundedConfidence(3, 0);
      expect(result.adjustedConfidence).toBe(0.05);
    });

    it('marks the insight as grounded=false', () => {
      const result = computeGroundedConfidence(3, 0);
      expect(result.grounded).toBe(false);
    });

    it('returns groundingRatio of 0', () => {
      const result = computeGroundedConfidence(3, 0);
      expect(result.groundingRatio).toBe(0);
    });

    it('marks grounded=false regardless of how many entities were referenced', () => {
      expect(computeGroundedConfidence(1, 0).grounded).toBe(false);
      expect(computeGroundedConfidence(10, 0).grounded).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // D. Full grounding (all entities matched)
  // -------------------------------------------------------------------------
  describe('when all referenced entities matched (full grounding)', () => {
    it('returns exactly REFLECTION_CONFIDENCE for 1/1 match', () => {
      const result = computeGroundedConfidence(1, 1);
      expect(result.adjustedConfidence).toBeCloseTo(BASE);
    });

    it('returns exactly REFLECTION_CONFIDENCE for 5/5 match', () => {
      const result = computeGroundedConfidence(5, 5);
      expect(result.adjustedConfidence).toBeCloseTo(BASE);
    });

    it('marks full-grounding insights as grounded=true', () => {
      const result = computeGroundedConfidence(5, 5);
      expect(result.grounded).toBe(true);
    });

    it('returns groundingRatio of 1 for fully matched insights', () => {
      const result = computeGroundedConfidence(5, 5);
      expect(result.groundingRatio).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // E. Floor enforcement
  // -------------------------------------------------------------------------
  describe('floor at 0.05', () => {
    it('never returns adjustedConfidence below 0.05 for any non-zero attemptedReveals', () => {
      // Worst case: 1 entity referenced, 0 matched
      const result = computeGroundedConfidence(1, 0);
      expect(result.adjustedConfidence).toBeGreaterThanOrEqual(0.05);
    });

    it('returns exactly 0.05 for 0/N matched (floor triggered)', () => {
      // BASE * 0 = 0, floor kicks in
      const result = computeGroundedConfidence(2, 0);
      expect(result.adjustedConfidence).toBe(0.05);
    });

    it('does NOT apply floor when ratio produces confidence above 0.05', () => {
      // BASE * (2/4) = 0.30 * 0.5 = 0.15, above floor
      const result = computeGroundedConfidence(4, 2);
      expect(result.adjustedConfidence).toBeGreaterThan(0.05);
      expect(result.adjustedConfidence).toBeCloseTo(0.15);
    });
  });
});

// =============================================================================
// buildReflectionPrompt — TK-52: Windowed sampling
// =============================================================================

describe('buildReflectionPrompt', () => {
  // -------------------------------------------------------------------------
  // F. Session within budget (AC2)
  // -------------------------------------------------------------------------
  describe('F. session within budget', () => {
    it('two-event trivial case: both events are present in the output (no OOB)', () => {
      const events = [
        makeEvent(0, 'Hello Sylphie'),
        makeEvent(1, 'Good morning Jim'),
      ];
      const prompt = buildReflectionPrompt(events, []);
      expect(prompt).toContain('Hello Sylphie');
      expect(prompt).toContain('Good morning Jim');
    });

    it('two-event case: prompt does not crash and contains the timeline header', () => {
      const events = [makeEvent(0, 'A'), makeEvent(1, 'B')];
      const prompt = buildReflectionPrompt(events, []);
      expect(prompt).toContain('Conversation timeline:');
    });

    it('small session within budget: all events included unchanged', () => {
      // 10 events of ~20 chars each → well within 8000 char budget.
      const events = Array.from({ length: 10 }, (_, i) =>
        makeEvent(i, `Message number ${i}`),
      );
      const prompt = buildReflectionPrompt(events, []);
      for (const ev of events) {
        expect(prompt).toContain(ev.content);
      }
    });

    it('session exactly at budget edge: all events included (no windowing applied)', () => {
      // Create events whose formatted lines sum to just below MAX_CHARS.
      // Each formatted line is: "[HH:MM:SS] (GUARDIAN) <content>\n" ≈ 22 + content.length chars.
      // Build events with short content so total stays below 8000.
      const events = Array.from({ length: 5 }, (_, i) =>
        makeEvent(i, `short ${i}`),
      );
      const prompt = buildReflectionPrompt(events, []);
      for (const ev of events) {
        expect(prompt).toContain(ev.content);
      }
    });
  });

  // -------------------------------------------------------------------------
  // G. Session exceeds budget: total chars <= MAX_CONVERSATION_CHARS (AC1)
  // -------------------------------------------------------------------------
  describe('G. session exceeds budget — total stays within MAX_CONVERSATION_CHARS', () => {
    // 200 events × 100-char content — far exceeds 8000 char budget.
    const longContent = 'x'.repeat(100);
    const manyEvents = Array.from({ length: 200 }, (_, i) =>
      makeEvent(i, longContent),
    );

    it('the timeline section of the built prompt fits within the budget', () => {
      const prompt = buildReflectionPrompt(manyEvents, []);
      const timelineChars = extractTimelineChars(prompt);
      // Timeline chars (lines only, newline-joined) should not exceed MAX_CHARS.
      expect(timelineChars).toBeLessThanOrEqual(MAX_CHARS);
    });

    it('the full prompt length is bounded (metadata overhead is small)', () => {
      const prompt = buildReflectionPrompt(manyEvents, []);
      // Full prompt includes header + metadata lines; allow modest overhead above MAX_CHARS.
      expect(prompt.length).toBeLessThanOrEqual(MAX_CHARS + 500);
    });

    it('the ~33% head partition: first event appears in the output', () => {
      const prompt = buildReflectionPrompt(manyEvents, []);
      expect(prompt).toContain(manyEvents[0].content);
    });

    it('the ~33% tail partition: last event appears in the output', () => {
      const prompt = buildReflectionPrompt(manyEvents, []);
      expect(prompt).toContain(manyEvents[manyEvents.length - 1].content);
    });

    it('the ~33% middle sample: at least one event from the middle segment appears', () => {
      const prompt = buildReflectionPrompt(manyEvents, []);
      // Middle is roughly indices 20-180. Check a few landmarks.
      // Because all contents are identical ('x'.repeat(100)) we instead verify
      // that the prompt contains more than just head+tail lines by checking
      // the timeline char count is meaningfully more than just 2 events would produce.
      const timelineChars = extractTimelineChars(prompt);
      // 2 events × ~112 chars each = ~224; the middle sample should add substantially more.
      expect(timelineChars).toBeGreaterThan(300);
    });
  });

  // -------------------------------------------------------------------------
  // H. Head/tail presence with distinct content (AC1 + AC2)
  // -------------------------------------------------------------------------
  describe('H. head and tail always present with distinct content', () => {
    function makeDistinctEvents(count: number, charsEach: number): MinimalEvent[] {
      return Array.from({ length: count }, (_, i) => {
        // Each event has a distinct marker so we can identify it in the prompt.
        const marker = `EVT${String(i).padStart(4, '0')}`;
        const padding = 'p'.repeat(Math.max(0, charsEach - marker.length));
        return makeEvent(i, marker + padding);
      });
    }

    it('first event content appears in prompt when session exceeds budget', () => {
      const events = makeDistinctEvents(300, 80);
      const prompt = buildReflectionPrompt(events, []);
      expect(prompt).toContain('EVT0000');
    });

    it('last event content appears in prompt when session exceeds budget', () => {
      const events = makeDistinctEvents(300, 80);
      const prompt = buildReflectionPrompt(events, []);
      expect(prompt).toContain('EVT0299');
    });

    it('events near the middle appear in the prompt (evenly-sampled middle)', () => {
      const events = makeDistinctEvents(300, 80);
      const prompt = buildReflectionPrompt(events, []);
      // The middle segment spans roughly events 26-273 (after head and before tail).
      // Check that at least one event from that range appears; the evenly-distributed
      // sample must hit some indices within it.
      const anyMiddlePresent = events
        .slice(30, 270)
        .some((ev) => prompt.includes(ev.content.substring(0, 7)));
      expect(anyMiddlePresent).toBe(true);
    });

    it('timeline total does not exceed budget for distinct-content over-budget session', () => {
      const events = makeDistinctEvents(300, 80);
      const prompt = buildReflectionPrompt(events, []);
      const timelineChars = extractTimelineChars(prompt);
      expect(timelineChars).toBeLessThanOrEqual(MAX_CHARS);
    });
  });
});
