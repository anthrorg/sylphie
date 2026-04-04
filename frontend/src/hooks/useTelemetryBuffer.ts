import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../store'

export interface BufferedTelemetry {
  timestamp: number
  pressure: Record<string, number>
  state: string
  category: string | null
  action: string | null
  actionConfidence: number | null
  driveEntropy?: number
  dominantDrive?: string | null
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000
const MAX_ENTRIES = 300

export function useTelemetryBuffer(windowMs: number = DEFAULT_WINDOW_MS) {
  const bufferRef = useRef<BufferedTelemetry[]>([])

  useEffect(() => {
    const unsub = useAppStore.subscribe((state, prevState) => {
      if (state.pressureSequenceNumber === prevState.pressureSequenceNumber) {
        return
      }

      const entry: BufferedTelemetry = {
        timestamp: Date.now() / 1000,
        pressure: { ...state.pressure },
        state: state.executorState,
        category: state.currentCategory,
        action: state.currentAction,
        actionConfidence: state.actionConfidence,
      }

      const buf = bufferRef.current
      buf.push(entry)

      if (buf.length > MAX_ENTRIES) {
        buf.splice(0, buf.length - MAX_ENTRIES)
      }

      const cutoff = Date.now() / 1000 - windowMs / 1000
      while (buf.length > 0 && buf[0].timestamp < cutoff) {
        buf.shift()
      }
    })

    return unsub
  }, [windowMs])

  const getSnapshot = useCallback((): string => {
    const buf = bufferRef.current
    if (buf.length === 0) {
      return 'No telemetry data available yet.'
    }

    const latest = buf[buf.length - 1]
    const oldest = buf[0]
    const durationS = Math.round(latest.timestamp - oldest.timestamp)

    const actionCounts: Record<string, number> = {}
    const stateCounts: Record<string, number> = {}
    const categoryCounts: Record<string, number> = {}

    for (const entry of buf) {
      if (entry.action) {
        actionCounts[entry.action] = (actionCounts[entry.action] || 0) + 1
      }
      stateCounts[entry.state] = (stateCounts[entry.state] || 0) + 1
      if (entry.category) {
        categoryCounts[entry.category] = (categoryCounts[entry.category] || 0) + 1
      }
    }

    const pressureLines = Object.entries(latest.pressure)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `  ${k}: ${v.toFixed(3)}`)
      .join('\n')

    const topActions = Object.entries(actionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([a, c]) => `  ${a}: ${c}x`)
      .join('\n')

    const topCategories = Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([c, n]) => `  ${c}: ${n}x`)
      .join('\n')

    // stateCounts is computed but only used for context; include dominant state in summary
    const dominantState = Object.entries(stateCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown'

    return [
      `Telemetry buffer: ${buf.length} entries over ${durationS}s`,
      `Dominant executor state: ${dominantState}`,
      '',
      `Current state: ${latest.state}`,
      `Current action: ${latest.action || 'none'}`,
      `Current category: ${latest.category || 'none'}`,
      '',
      'Current drive pressures (highest first):',
      pressureLines,
      '',
      'Recent actions (last 5min):',
      topActions || '  none',
      '',
      'Drive categories triggered:',
      topCategories || '  none',
    ].join('\n')
  }, [])

  return { getSnapshot, bufferRef }
}
