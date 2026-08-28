import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// AC (TK-145): the dead telemetry handlers are wired to real events or
// removed. Confirmed (via a first-party source sweep): nothing in the
// backend has ever emitted 'prediction_result', 'maintenance_cycle', or
// 'state_transition' — only 'executor_cycle' (drive-publisher.service.ts)
// and 'system_log' (telemetry-broadcast.service.ts) are real producers.
// This build chose REMOVAL for those three dead switch cases.

describe('useTelemetryWebSocket — dead telemetry message handlers removed (TK-145)', () => {
  it('no longer handles prediction_result / maintenance_cycle / state_transition', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'useWebSocket.ts'),
      'utf-8',
    )
    expect(source).not.toMatch(/case 'prediction_result'/)
    expect(source).not.toMatch(/case 'maintenance_cycle'/)
    expect(source).not.toMatch(/case 'state_transition'/)
    // The real producers stay wired.
    expect(source).toMatch(/case 'executor_cycle'/)
    expect(source).toMatch(/case 'system_log'/)
  })
})
