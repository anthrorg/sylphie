import { useState, useEffect } from 'react'
import { useAppStore } from '../store'

interface UsePressureStatusReturn {
  isConnected: boolean
  isStale: boolean
}

export function usePressureStatus(pollIntervalMs: number = 5000): UsePressureStatusReturn {
  const pressureIsStale = useAppStore((state) => state.pressureIsStale)
  const pressureSeq = useAppStore((state) => state.pressureSequenceNumber)
  const telemetryWsState = useAppStore((state) => state.wsState.telemetry)

  const [isConnected, setIsConnected] = useState(false)
  const [isStale, setIsStale] = useState(true)

  // Derive from telemetry WS + pressure data
  useEffect(() => {
    const wsUp = telemetryWsState === 'connected'
    const hasData = pressureSeq > 0
    setIsConnected(wsUp && hasData)
    setIsStale(hasData ? pressureIsStale : true)
  }, [telemetryWsState, pressureSeq, pressureIsStale])

  // Also poll /api/pressure for direct drive engine status
  useEffect(() => {
    const fetchStatus = () => {
      fetch('/api/pressure')
        .then((res) => {
          if (!res.ok) throw new Error(`GET /api/pressure: ${res.status}`)
          return res.json()
        })
        .then((data: { is_connected?: boolean; is_stale?: boolean }) => {
          setIsConnected(data.is_connected ?? false)
          setIsStale(data.is_stale ?? true)
        })
        .catch(() => {
          setIsConnected(false)
          setIsStale(true)
        })
    }

    fetchStatus()
    const interval = setInterval(fetchStatus, pollIntervalMs)
    return () => clearInterval(interval)
  }, [pollIntervalMs])

  return { isConnected, isStale }
}
