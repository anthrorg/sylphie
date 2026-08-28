import { useState, useEffect } from 'react'

interface UsePressureStatusReturn {
  isConnected: boolean
  isStale: boolean
}

/**
 * TK-149 (item 20260702-005): this hook used to have TWO independent writers
 * for the same `isConnected`/`isStale` state — one derived from the
 * telemetry WS + Zustand pressure fields, one from polling GET /api/pressure
 * directly — each `useEffect` overwriting whatever the other had just set,
 * with no ordering guarantee (last one to fire wins). That's a genuine
 * last-writer-wins race, not two views of the same fact: the WS-derived
 * signal only reflects THIS browser tab's socket to the backend, while
 * GET /api/pressure reports the backend's actual connection to the drive
 * engine — a different, more authoritative fact for "is pressure live".
 *
 * Single source of truth: the poll. It is what "isConnected"/"isStale"
 * conceptually mean here (drive-engine liveness), it's already the more
 * authoritative signal, and dropping the WS-derived guess removes the race
 * entirely rather than papering over it with priority rules.
 */
export function usePressureStatus(pollIntervalMs: number = 5000): UsePressureStatusReturn {
  const [isConnected, setIsConnected] = useState(false)
  const [isStale, setIsStale] = useState(true)

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
