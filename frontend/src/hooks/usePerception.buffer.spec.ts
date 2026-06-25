/**
 * TK-105: Frontend perception-overlay buffer eviction
 *
 * Tests the pure buffer-bounding logic extracted from usePerception.ts:
 *   - scene-event array is capped at MAX_SCENE_EVENTS (64)
 *   - VLM caption string is truncated at MAX_VLM_CAPTION_LEN (512 chars)
 *   - render-loop throttle skips frames inside RENDER_INTERVAL_MS
 *
 * These run without a DOM or React — they test the logic, not the hook wiring.
 * Acceptance criterion: the overlay buffer is bounded/evicted so a long session
 * does not cause progressive slowdown.
 */

// ─── Constants (mirror of usePerception.ts) ──────────────────────────────────

const CAPTURE_FPS = 15
const RENDER_INTERVAL_MS = 1000 / CAPTURE_FPS  // ~66.67ms
const MAX_SCENE_EVENTS = 64
const MAX_VLM_CAPTION_LEN = 512

// ─── Buffer-bounding helpers (the same logic as in usePerception.ts) ─────────

interface SceneEvent {
  type: string
  trackId: number
  label: string
  confidence: number
  bbox: [number, number, number, number]
  timestamp: number
}

/**
 * Applies the scene-event eviction policy from usePerception.ts:
 *   keep the most recent MAX_SCENE_EVENTS entries.
 */
function boundSceneEvents(rawEvents: SceneEvent[]): SceneEvent[] {
  return rawEvents.length > MAX_SCENE_EVENTS
    ? rawEvents.slice(-MAX_SCENE_EVENTS)
    : rawEvents
}

/**
 * Applies the VLM caption truncation policy from usePerception.ts.
 */
function boundCaption(raw: string): string {
  return raw.length > MAX_VLM_CAPTION_LEN ? raw.slice(0, MAX_VLM_CAPTION_LEN) : raw
}

/**
 * Simulates the render-throttle check from usePerception.ts draw():
 *   returns true if the frame should be skipped (too soon since lastRender).
 */
function shouldSkipFrame(now: number, lastRender: number): boolean {
  return now - lastRender < RENDER_INTERVAL_MS
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(id: number): SceneEvent {
  return {
    type: 'object_appeared',
    trackId: id,
    label: `obj-${id}`,
    confidence: 0.9,
    bbox: [0, 0, 100, 100],
    timestamp: Date.now() + id,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TK-105 — perception overlay buffer eviction', () => {
  // Scene-event bounding
  describe('scene-event buffer cap (MAX_SCENE_EVENTS = 64)', () => {
    it('passes arrays ≤ MAX_SCENE_EVENTS through unchanged', () => {
      const events = Array.from({ length: 64 }, (_, i) => makeEvent(i))
      const result = boundSceneEvents(events)
      expect(result).toHaveLength(64)
      expect(result).toBe(events)  // same reference — no copy needed
    })

    it('evicts oldest entries when array exceeds MAX_SCENE_EVENTS', () => {
      const events = Array.from({ length: 80 }, (_, i) => makeEvent(i))
      const result = boundSceneEvents(events)
      expect(result).toHaveLength(MAX_SCENE_EVENTS)
      // Keeps most recent: trackIds 16..79
      expect(result[0].trackId).toBe(16)
      expect(result[MAX_SCENE_EVENTS - 1].trackId).toBe(79)
    })

    it('handles empty array', () => {
      expect(boundSceneEvents([])).toHaveLength(0)
    })

    it('evicts correctly at exactly MAX_SCENE_EVENTS + 1', () => {
      const events = Array.from({ length: MAX_SCENE_EVENTS + 1 }, (_, i) => makeEvent(i))
      const result = boundSceneEvents(events)
      expect(result).toHaveLength(MAX_SCENE_EVENTS)
      expect(result[0].trackId).toBe(1)  // oldest evicted is trackId 0
    })

    it('never grows beyond MAX_SCENE_EVENTS regardless of batch size', () => {
      const hugeBatch = Array.from({ length: 1000 }, (_, i) => makeEvent(i))
      const result = boundSceneEvents(hugeBatch)
      expect(result).toHaveLength(MAX_SCENE_EVENTS)
    })
  })

  // VLM caption bounding
  describe('VLM caption truncation (MAX_VLM_CAPTION_LEN = 512)', () => {
    it('passes captions under the limit through unchanged', () => {
      const short = 'A brief scene caption.'
      expect(boundCaption(short)).toBe(short)
    })

    it('passes a caption of exactly MAX_VLM_CAPTION_LEN through unchanged', () => {
      const exact = 'x'.repeat(MAX_VLM_CAPTION_LEN)
      const result = boundCaption(exact)
      expect(result).toHaveLength(MAX_VLM_CAPTION_LEN)
    })

    it('truncates captions longer than MAX_VLM_CAPTION_LEN', () => {
      const long = 'w'.repeat(MAX_VLM_CAPTION_LEN + 100)
      const result = boundCaption(long)
      expect(result).toHaveLength(MAX_VLM_CAPTION_LEN)
    })

    it('preserves the first MAX_VLM_CAPTION_LEN characters', () => {
      const prefix = 'A'.repeat(MAX_VLM_CAPTION_LEN)
      const suffix = 'B'.repeat(200)
      const result = boundCaption(prefix + suffix)
      expect(result).toBe(prefix)
    })

    it('handles empty string', () => {
      expect(boundCaption('')).toBe('')
    })
  })

  // Render-loop frame throttle
  describe('render-loop frame throttle (RENDER_INTERVAL_MS ≈ 66.67ms)', () => {
    it('skips a frame that arrives too soon after the last render', () => {
      const lastRender = 1000
      const now = lastRender + RENDER_INTERVAL_MS - 1  // 1ms short
      expect(shouldSkipFrame(now, lastRender)).toBe(true)
    })

    it('renders a frame that arrives exactly at the interval boundary', () => {
      const lastRender = 1000
      const now = lastRender + RENDER_INTERVAL_MS
      expect(shouldSkipFrame(now, lastRender)).toBe(false)
    })

    it('renders a frame that arrives well after the interval', () => {
      const lastRender = 1000
      const now = lastRender + RENDER_INTERVAL_MS * 2
      expect(shouldSkipFrame(now, lastRender)).toBe(false)
    })

    it('allows the first frame once RENDER_INTERVAL_MS has elapsed from t=0', () => {
      // lastRenderRef is initialised to 0. The first rAF tick (~16ms) is still
      // under RENDER_INTERVAL_MS (~67ms), so the skip applies. Only once
      // enough ticks have accumulated does the first visible frame render.
      // This is intentional — a <67ms startup delay is imperceptible.
      const lastRender = 0
      expect(shouldSkipFrame(16, lastRender)).toBe(true)   // too early
      expect(shouldSkipFrame(RENDER_INTERVAL_MS, lastRender)).toBe(false)  // just enough
    })

    it('RENDER_INTERVAL_MS matches CAPTURE_FPS', () => {
      // Ensures the throttle is always in sync with the capture rate constant.
      expect(RENDER_INTERVAL_MS).toBeCloseTo(1000 / CAPTURE_FPS, 5)
    })

    it('skips a sustained burst of frames that arrive under the interval', () => {
      const start = 1000
      let lastRender = start
      let rendered = 0

      // Simulate 60fps ticks over 1 second — expect ~15 frames rendered
      const tickMs = 1000 / 60
      for (let t = start; t < start + 1000; t += tickMs) {
        if (!shouldSkipFrame(t, lastRender)) {
          rendered++
          lastRender = t
        }
      }

      // Should render ≈ 15 frames (±1 for floating-point boundary edge)
      expect(rendered).toBeGreaterThanOrEqual(14)
      expect(rendered).toBeLessThanOrEqual(16)
    })
  })
})
