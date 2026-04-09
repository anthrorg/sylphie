// ---------------------------------------------------------------------------
// useSupervisorWebSocket — connects to /ws/supervisor and feeds verdicts into
// the supervisor Zustand store. Mirrors the reconnect/backoff pattern used by
// useGraphWebSocket and useTelemetryWebSocket.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useCallback } from 'react'
import { useSupervisorStore, SupervisorVerdict } from '../store/supervisorSlice'

// Derive WS URL from current window origin — same pattern as useWebSocket.ts
const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const WS_BASE = `${WS_PROTOCOL}//${window.location.host}`

interface SupervisorWsMessage {
  type: string
  verdict?: SupervisorVerdict
}

export function useSupervisorWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)

  const { addVerdict } = useSupervisorStore()

  const computeBackoffDelay = useCallback((attempt: number) => {
    const base = Math.min(1000 * Math.pow(2, attempt), 30000)
    const jitter = 0.8 + Math.random() * 0.4
    return Math.round(base * jitter)
  }, [])

  const connect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      wsRef.current.close()
    }

    try {
      const ws = new WebSocket(`${WS_BASE}/ws/supervisor`)
      wsRef.current = ws

      ws.onopen = () => {
        if (wsRef.current !== ws) return
        console.info('[Supervisor] WebSocket opened')
        reconnectAttemptRef.current = 0
      }

      ws.onmessage = (event) => {
        try {
          const message: SupervisorWsMessage = JSON.parse(event.data as string)

          if (message.type === 'supervisor_verdict' && message.verdict) {
            addVerdict(message.verdict)
          }
        } catch {
          console.warn('[Supervisor] Invalid JSON message')
        }
      }

      ws.onerror = () => {
        console.warn('[Supervisor] WebSocket error')
      }

      ws.onclose = (event) => {
        console.info(`[Supervisor] WebSocket closed (${event.code})`)
        if (wsRef.current !== ws) return
        wsRef.current = null
        scheduleReconnect()
      }
    } catch (error) {
      console.error('[Supervisor] Could not create WebSocket:', error)
      scheduleReconnect()
    }
  }, [addVerdict])

  const scheduleReconnect = useCallback(() => {
    const delay = computeBackoffDelay(reconnectAttemptRef.current)
    reconnectAttemptRef.current++

    console.info(
      `[Supervisor] Reconnecting in ${delay}ms (attempt ${reconnectAttemptRef.current})`,
    )

    reconnectTimeoutRef.current = window.setTimeout(() => {
      reconnectTimeoutRef.current = null
      connect()
    }, delay)
  }, [connect, computeBackoffDelay])

  useEffect(() => {
    connect()

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      wsRef.current?.close()
    }
  }, [connect])
}
