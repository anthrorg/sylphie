import { useState, useRef, useCallback, useEffect } from 'react'
import { useAppStore } from '../store'
import { TelemetryPressure } from '../types'

const DEBOUNCE_MS = 300

interface UseDriveOverridesReturn {
  overrides: Record<string, boolean>
  overrideValues: Record<string, number>
  driftRates: Record<string, number>
  anyOverrideActive: boolean
  handleOverrideToggle: (key: string, enabled: boolean) => void
  handleOverrideValue: (key: string, value: number) => void
  handleDriftChange: (key: string, rate: number) => void
  handleResetAll: () => void
}

function debouncedPost(
  url: string,
  body: Record<string, unknown>,
  timerRef: React.MutableRefObject<Record<string, ReturnType<typeof setTimeout>>>,
  timerKey: string,
): void {
  if (timerRef.current[timerKey]) {
    clearTimeout(timerRef.current[timerKey])
  }
  timerRef.current[timerKey] = setTimeout(() => {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch((err) => console.error(`POST ${url} failed:`, err))
    delete timerRef.current[timerKey]
  }, DEBOUNCE_MS)
}

export function useDriveOverrides(): UseDriveOverridesReturn {
  const pressure = useAppStore((state) => state.pressure)

  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [overrideValues, setOverrideValues] = useState<Record<string, number>>({})
  const [driftRates, setDriftRates] = useState<Record<string, number>>({})

  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  useEffect(() => {
    const timers = debounceTimers.current
    return () => {
      Object.values(timers).forEach(clearTimeout)
    }
  }, [])

  const handleOverrideToggle = useCallback(
    (key: string, enabled: boolean) => {
      setOverrides((prev) => ({ ...prev, [key]: enabled }))
      const value = enabled
        ? (overrideValues[key] ?? pressure[key as keyof TelemetryPressure] ?? 0.5)
        : 0
      if (enabled) {
        setOverrideValues((prev) => ({ ...prev, [key]: value }))
      }
      fetch('/api/drives/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drive: key, value, active: enabled }),
      }).catch((err) => console.error('Override toggle failed:', err))
    },
    [overrideValues, pressure],
  )

  const handleOverrideValue = useCallback((key: string, value: number) => {
    setOverrideValues((prev) => ({ ...prev, [key]: value }))
    debouncedPost('/api/drives/override', { drive: key, value, active: true }, debounceTimers, `override-${key}`)
  }, [])

  const handleDriftChange = useCallback((key: string, rate: number) => {
    setDriftRates((prev) => ({ ...prev, [key]: rate }))
    debouncedPost('/api/drives/drift', { drive: key, rate }, debounceTimers, `drift-${key}`)
  }, [])

  const handleResetAll = useCallback(() => {
    fetch('/api/drives/reset', { method: 'POST' })
      .then((res) => {
        if (!res.ok) throw new Error(`POST /api/drives/reset: ${res.status}`)
        setOverrides({})
        setOverrideValues({})
        setDriftRates({})
      })
      .catch((err) => console.error('Reset failed:', err))
  }, [])

  const anyOverrideActive = Object.values(overrides).some(Boolean)

  return { overrides, overrideValues, driftRates, anyOverrideActive, handleOverrideToggle, handleOverrideValue, handleDriftChange, handleResetAll }
}
