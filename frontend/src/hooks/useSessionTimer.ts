import { useState, useEffect } from 'react'

/**
 * Tracks elapsed time from a start timestamp, updating every second.
 * Returns a formatted string like "3:45" or "1:02:15".
 */
export function useSessionTimer(startTimestamp: number): string {
  const [elapsed, setElapsed] = useState('0:00')

  useEffect(() => {
    const interval = setInterval(() => {
      const totalSeconds = Math.floor((Date.now() - startTimestamp) / 1000)
      const s = totalSeconds % 60
      const totalMinutes = Math.floor(totalSeconds / 60)
      const m = totalMinutes % 60
      const h = Math.floor(totalMinutes / 60)
      const ss = String(s).padStart(2, '0')

      if (h > 0) {
        const mm = String(m).padStart(2, '0')
        setElapsed(`${h}:${mm}:${ss}`)
      } else {
        setElapsed(`${m}:${ss}`)
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [startTimestamp])

  return elapsed
}
