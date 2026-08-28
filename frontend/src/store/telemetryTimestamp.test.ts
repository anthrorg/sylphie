import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from './index'
import type { TelemetryCycle } from '../types'

// AC (TK-145): the ms-vs-seconds timestamp mismatch is corrected.
//
// `TelemetryCycle.timestamp` is wall-clock MILLISECONDS (Date.now()), but
// `ActionHistoryEntry.timestamp` — and `formatRelativeTime` in
// MetricsPanel.tsx, which renders it — are SECONDS everywhere else
// (addActionToHistory / addPredictionToHistory both use Date.now() / 1000).
// updateTelemetry used to store the raw ms value directly, making every
// action look ~1000x further in the past than it actually was.

function makeCycle(overrides: Partial<TelemetryCycle> = {}): TelemetryCycle {
  return {
    type: 'executor_cycle',
    timestamp: Date.now(),
    pressure: {} as TelemetryCycle['pressure'],
    pressure_metadata: { sequence_number: 1, timestamp_ms: Date.now(), is_stale: false },
    drive_velocity: null,
    drive_entropy: 0,
    dominant_drive: null,
    category: 'curiosity',
    action: 'explore',
    action_confidence: 0.8,
    state: 'executing',
    transition_count: 1,
    cycle_count: 1,
    guardian_present: null,
    speech_refractory: 0,
    action_diversity: {},
    system_health: {},
    schema_version: 1,
    dynamic_threshold: 0.5,
    ...overrides,
  }
}

describe('updateTelemetry — actionHistory timestamp is stored in seconds (TK-145)', () => {
  beforeEach(() => {
    useAppStore.setState({ actionHistory: [], innerMonologue: [] })
  })

  it('divides the incoming ms timestamp by 1000 before storing an actionHistory entry', () => {
    const nowMs = Date.now()
    useAppStore.getState().updateTelemetry(makeCycle({ timestamp: nowMs }))

    const [entry] = useAppStore.getState().actionHistory
    expect(entry).toBeDefined()
    // Stored value must be in the same seconds-based epoch as
    // Date.now() / 1000, not the raw milliseconds value.
    expect(entry.timestamp).toBeCloseTo(nowMs / 1000, 0)
    expect(entry.timestamp).toBeLessThan(nowMs / 2) // sanity: NOT the raw ms value
  })

  it('a "just now" event does not render as hours old (regression guard on the actual consumer math)', () => {
    const nowMs = Date.now()
    useAppStore.getState().updateTelemetry(makeCycle({ timestamp: nowMs }))
    const [entry] = useAppStore.getState().actionHistory

    // Mirrors MetricsPanel.tsx's formatRelativeTime: `now (s) - entry.timestamp (s)`.
    const diffSeconds = Math.max(0, Math.floor(Date.now() / 1000 - entry.timestamp))
    expect(diffSeconds).toBeLessThan(5)
  })
})
