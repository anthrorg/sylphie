import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../store'
import { GraphDelta, ConversationMessage, TelemetryMessage } from '../types'
import { useUnmountGuard } from './useUnmountGuard'

// Use Vite proxy in dev so WebSocket paths are relative (/ws/...).
// In production, same host serves both the frontend and NestJS backend.
const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const WS_BASE = `${WS_PROTOCOL}//${window.location.host}`

// After receiving graph deltas, wait 1.5s of quiet before re-fetching the full snapshot.
// Prevents hammering GET /api/graph/snapshot during rapid mutation bursts.
const SNAPSHOT_REFETCH_DEBOUNCE_MS = 1500

export function useGraphWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)
  const refetchTimerRef = useRef<number | null>(null)
  const { isUnmounted, markUnmounted } = useUnmountGuard()

  // Per-field selectors — store actions have stable identity in Zustand, so
  // subscribing field-by-field avoids re-running this hook on unrelated state
  // changes (e.g. telemetry ticks).
  const setWsState = useAppStore((s) => s.setWsState)
  const setGraphData = useAppStore((s) => s.setGraphData)
  const setGraphStats = useAppStore((s) => s.setGraphStats)
  const resetStasisCount = useAppStore((s) => s.resetStasisCount)
  const setSessionStats = useAppStore((s) => s.setSessionStats)

  const computeBackoffDelay = useCallback((attempt: number) => {
    const base = Math.min(1000 * Math.pow(2, attempt), 30000)
    const jitter = 0.8 + Math.random() * 0.4
    return Math.round(base * jitter)
  }, [])

  const fetchSnapshot = useCallback(async () => {
    try {
      const res = await fetch('/api/graph/snapshot')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const data = await res.json()
      setGraphData(data)
      setGraphStats({ nodes: data.nodes?.length || 0, edges: data.edges?.length || 0 })
    } catch (error) {
      console.error('[Graph] Snapshot fetch failed:', error)
    }
  }, [setGraphData, setGraphStats])

  const scheduleDebouncedRefetch = useCallback(() => {
    if (refetchTimerRef.current !== null) {
      clearTimeout(refetchTimerRef.current)
    }
    refetchTimerRef.current = window.setTimeout(() => {
      refetchTimerRef.current = null
      fetchSnapshot()
    }, SNAPSHOT_REFETCH_DEBOUNCE_MS)
  }, [fetchSnapshot])

  const connect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    if (wsRef.current?.readyState !== WebSocket.CLOSED) {
      wsRef.current?.close()
    }

    try {
      const ws = new WebSocket(`${WS_BASE}/ws/graph?protocol=cobeing-v1`)
      wsRef.current = ws
      setWsState('graph', 'reconnecting')

      ws.onopen = () => {
        if (wsRef.current !== ws) return
        console.info('[Graph] WebSocket opened')
        const isReconnect = reconnectAttemptRef.current > 0
        setWsState('graph', 'connected')
        reconnectAttemptRef.current = 0

        if (isReconnect) {
          fetchSnapshot()
        }
      }

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data)
          const deltas = Array.isArray(parsed) ? parsed : [parsed]

          let deltaCount = 0

          deltas.forEach((delta: GraphDelta) => {
            if (delta.type === 'snapshot') {
              // cobeing-v1 sends { type: 'snapshot', snapshot: { nodes, edges } }
              // Legacy/native format sends { type: 'snapshot', data: { nodes, edges, total_nodes, total_edges } }
              const snapshotPayload = delta.snapshot ?? (delta.data as { nodes?: unknown[]; edges?: unknown[]; total_nodes?: number; total_edges?: number } | undefined)
              if (snapshotPayload) {
                const newNodeCount =
                  (snapshotPayload as { total_nodes?: number }).total_nodes ||
                  (snapshotPayload.nodes as unknown[])?.length ||
                  0
                const newEdgeCount =
                  (snapshotPayload as { total_edges?: number }).total_edges ||
                  (snapshotPayload.edges as unknown[])?.length ||
                  0
                const current = useAppStore.getState().graphStats
                if (newNodeCount !== current.nodes || newEdgeCount !== current.edges) {
                  setGraphData({
                    nodes: (snapshotPayload.nodes as Parameters<typeof setGraphData>[0]['nodes']) || [],
                    edges: (snapshotPayload.edges as Parameters<typeof setGraphData>[0]['edges']) || [],
                  })
                  setGraphStats({ nodes: newNodeCount, edges: newEdgeCount })
                }
              }
              return
            }
            deltaCount++
          })

          if (deltaCount > 0) {
            resetStasisCount()
            setSessionStats({
              graph_changes: useAppStore.getState().sessionStats.graph_changes + deltaCount,
            })
            scheduleDebouncedRefetch()
          }
        } catch (error) {
          console.warn('[Graph] Invalid JSON message')
        }
      }

      ws.onerror = () => {
        console.warn('[Graph] WebSocket error')
      }

      ws.onclose = (event) => {
        console.info(`[Graph] WebSocket closed (${event.code})`)
        if (wsRef.current !== ws) return
        wsRef.current = null
        // Unmounted — do NOT schedule a reconnect; this would spawn an orphan
        // socket that outlives the component (TK-141: zombie-socket fix).
        if (isUnmounted()) return
        setWsState('graph', 'reconnecting')
        scheduleReconnect()
      }
    } catch (error) {
      console.error('[Graph] Could not create WebSocket:', error)
      if (isUnmounted()) return
      setWsState('graph', 'reconnecting')
      scheduleReconnect()
    }
  }, [
    setWsState,
    fetchSnapshot,
    resetStasisCount,
    setSessionStats,
    setGraphData,
    setGraphStats,
    scheduleDebouncedRefetch,
    isUnmounted,
  ])

  const scheduleReconnect = useCallback(() => {
    const delay = computeBackoffDelay(reconnectAttemptRef.current)
    reconnectAttemptRef.current++

    console.info(`[Graph] Reconnecting in ${delay}ms (attempt ${reconnectAttemptRef.current})`)

    reconnectTimeoutRef.current = window.setTimeout(() => {
      reconnectTimeoutRef.current = null
      connect()
    }, delay)
  }, [connect, computeBackoffDelay])

  useEffect(() => {
    connect()
    fetchSnapshot()

    return () => {
      markUnmounted()
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current)
      }
      wsRef.current?.close()
    }
  }, [connect, fetchSnapshot, markUnmounted])

  return wsRef.current
}

export function useConversationWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)
  const { isUnmounted, markUnmounted } = useUnmountGuard()

  const setWsState = useAppStore((s) => s.setWsState)
  const addMessage = useAppStore((s) => s.addMessage)
  const incrementTurns = useAppStore((s) => s.incrementTurns)
  const setThinking = useAppStore((s) => s.setThinking)
  const setQueuePosition = useAppStore((s) => s.setQueuePosition)

  const computeBackoffDelay = useCallback((attempt: number) => {
    const base = Math.min(1000 * Math.pow(2, attempt), 30000)
    const jitter = 0.8 + Math.random() * 0.4
    return Math.round(base * jitter)
  }, [])

  const sendMessage = useCallback((message: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message))
      return true
    }
    console.warn('[Conversation] sendMessage FAILED -- socket not open')
    return false
  }, [])

  // sendTextMessage wraps the guardian's text in the NestJS @nestjs/platform-ws
  // envelope expected by @SubscribeMessage('message') on the ConversationGateway.
  // Format: { event: 'message', data: { text, type: 'message' } }
  const sendTextMessage = useCallback((text: string) => {
    return sendMessage({ event: 'message', data: { text, type: 'message' } })
  }, [sendMessage])

  const connect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    // Close the old socket AND null the ref so its event handlers become
    // no-ops (they guard on `wsRef.current !== ws`). This prevents the
    // race where the new socket opens before the old one's onclose fires,
    // which was causing the server to see 2 clients and double-deliver.
    const oldWs = wsRef.current
    wsRef.current = null
    if (oldWs && oldWs.readyState !== WebSocket.CLOSED) {
      oldWs.close()
    }

    try {
      const connId = Math.random().toString(36).slice(2, 8)
      // Include auth token so backend can identify the user for OKG person modeling
      const token = localStorage.getItem('sylphie_token')
      const authParam = token ? `&token=${encodeURIComponent(token)}` : ''
      const wsUrl = `${WS_BASE}/ws/conversation?protocol=cobeing-v1${authParam}`
      console.info(`[Conversation] Creating new WebSocket (connId=${connId})`, {
        url: `${WS_BASE}/ws/conversation?protocol=cobeing-v1`,
      })
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws
      setWsState('conversation', 'reconnecting')

      ws.onopen = () => {
        if (wsRef.current !== ws) return
        console.info('[Conversation] WebSocket opened', { url: ws.url, protocol: ws.protocol })
        setWsState('conversation', 'connected')
        reconnectAttemptRef.current = 0
      }

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)

          // Server echoes back an ack for guardian inputs; skip since we already
          // optimistically rendered the user's message in ConversationPanel.
          if (message.type === 'input_ack') {
            return
          }

          // thinking_indicator is a flag, not a message — update state, don't add to feed.
          if (message.type === 'thinking_indicator') {
            setThinking(!!message.is_thinking)
            // WS4 Ticket 6: clear queue position when Sylphie starts processing our
            // turn (thinking indicator on our socket means we are now being served).
            if (message.is_thinking) {
              setQueuePosition(null)
            }
            return
          }

          // WS4 Ticket 6 — queue_position: this socket's turn is queued at position N.
          // Received only when this socket has a turn waiting behind others.
          // Cleared when thinking_indicator arrives (our turn is being served) or
          // when cb_speech arrives (response delivered).
          if (message.type === 'queue_position') {
            setQueuePosition(typeof message.position === 'number' ? message.position : null)
            return
          }

          // Legacy: system_status with is_thinking is also a thinking indicator
          if (message.type === 'system_status' && message.is_thinking !== undefined) {
            setThinking(!!message.is_thinking)
            return
          }

          // cobeing-v1: system_status with no text is the session-start confirmation — skip.
          if (message.type === 'system_status' && !message.text) {
            return
          }

          addMessage(message as ConversationMessage)

          // cobeing-v1 sends Sylphie's replies as 'cb_speech'; native protocol sends 'response'.
          // Both count as completed turns for session statistics and stasis detection.
          if (message.type === 'response' || message.type === 'cb_speech') {
            // WS4 Ticket 6: clear any residual queue position — our turn was served.
            setQueuePosition(null)
            incrementTurns()

            // If the response carries inline TTS audio, dispatch a CustomEvent
            // so AudioPanel and useVoiceRecording can play it
            if (message.audioBase64 && message.audioFormat) {
              window.dispatchEvent(
                new CustomEvent('sylphie:audio_response', {
                  detail: {
                    audioBase64: message.audioBase64,
                    audioFormat: message.audioFormat,
                  },
                }),
              )
            }
          }
        } catch (error) {
          console.warn('[Conversation] Invalid JSON message:', event.data)
        }
      }

      ws.onerror = (event) => {
        console.warn('[Conversation] WebSocket error', event)
      }

      ws.onclose = (event) => {
        console.info(`[Conversation] WebSocket closed`, {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        })
        if (wsRef.current !== ws) return
        wsRef.current = null
        // 1012 = server evicted this tab; stay disconnected to avoid infinite reconnect loop.
        if (event.code === 1012) {
          setWsState('conversation', 'disconnected')
          return
        }
        // Unmounted — do NOT schedule a reconnect (TK-141: zombie-socket fix).
        if (isUnmounted()) return
        setWsState('conversation', 'reconnecting')
        scheduleReconnect()
      }
    } catch (error) {
      console.error('[Conversation] Could not create WebSocket:', error)
      if (isUnmounted()) return
      setWsState('conversation', 'reconnecting')
      scheduleReconnect()
    }
  }, [setWsState, addMessage, incrementTurns, setThinking, setQueuePosition, isUnmounted])

  const scheduleReconnect = useCallback(() => {
    const delay = computeBackoffDelay(reconnectAttemptRef.current)
    reconnectAttemptRef.current++

    console.info(
      `[Conversation] Reconnecting in ${delay}ms (attempt ${reconnectAttemptRef.current})`,
    )

    reconnectTimeoutRef.current = window.setTimeout(() => {
      reconnectTimeoutRef.current = null
      connect()
    }, delay)
  }, [connect, computeBackoffDelay])

  useEffect(() => {
    connect()

    return () => {
      markUnmounted()
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      wsRef.current?.close()
    }
  }, [connect, markUnmounted])

  return { ws: wsRef.current, sendMessage, sendTextMessage }
}

export function useTelemetryWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)
  const { isUnmounted, markUnmounted } = useUnmountGuard()

  const setWsState = useAppStore((s) => s.setWsState)
  const updateTelemetry = useAppStore((s) => s.updateTelemetry)
  const addSystemLog = useAppStore((s) => s.addSystemLog)

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

    if (wsRef.current?.readyState !== WebSocket.CLOSED) {
      wsRef.current?.close()
    }

    try {
      const ws = new WebSocket(`${WS_BASE}/ws/telemetry?protocol=cobeing-v1`)
      wsRef.current = ws
      setWsState('telemetry', 'reconnecting')

      ws.onopen = () => {
        if (wsRef.current !== ws) return
        console.info('[Telemetry] WebSocket opened')
        setWsState('telemetry', 'connected')
        reconnectAttemptRef.current = 0
      }

      ws.onmessage = (event) => {
        try {
          const message: TelemetryMessage = JSON.parse(event.data)

          const ts = new Date().toISOString()

          switch (message.type) {
            case 'executor_cycle':
              updateTelemetry(message)
              if (message.action) {
                addSystemLog({
                  text: `[executor] ${message.category ?? 'idle'} → ${message.action} (conf=${(message.action_confidence ?? 0).toFixed(2)})`,
                  timestamp: ts,
                  level: 'info',
                })
              }
              break

            // TK-145 (item 20260702-005): 'prediction_result', 'maintenance_cycle',
            // and 'state_transition' were REMOVED here (not wired) — nothing in
            // the backend has ever emitted any of the three (confirmed: only
            // drive-publisher.service.ts's 'executor_cycle' and
            // telemetry-broadcast.service.ts's 'system_log' produce telemetry
            // messages). Handling a message type with no producer is dead code
            // that implies a data feed exists when it never did; removing it
            // is the ticket's explicit "wire to a real event or remove" rule.
            // predictionHistory/addPredictionToHistory remain in the store —
            // PredictionAccuracyPanel's honest "No predictions yet" empty
            // state is a smaller, separate call left for ashby/architect
            // (whether to build real prediction telemetry is a feature, not
            // this bug fix's scope).

            case 'system_log':
              addSystemLog({
                text: message.text,
                timestamp: message.timestamp ?? ts,
                level: message.level ?? 'info',
              })
              break

            default:
              console.warn(
                '[Telemetry] Unknown message type:',
                (message as { type: string }).type,
              )
          }
        } catch (error) {
          console.warn('[Telemetry] Invalid JSON message')
        }
      }

      ws.onerror = () => {
        console.warn('[Telemetry] WebSocket error')
      }

      ws.onclose = (event) => {
        console.info(`[Telemetry] WebSocket closed (${event.code})`)
        if (wsRef.current !== ws) return
        wsRef.current = null
        // Unmounted — do NOT schedule a reconnect (TK-141: zombie-socket fix).
        if (isUnmounted()) return
        setWsState('telemetry', 'reconnecting')
        scheduleReconnect()
      }
    } catch (error) {
      console.error('[Telemetry] Could not create WebSocket:', error)
      if (isUnmounted()) return
      setWsState('telemetry', 'reconnecting')
      scheduleReconnect()
    }
  }, [setWsState, updateTelemetry, addSystemLog, isUnmounted])

  const scheduleReconnect = useCallback(() => {
    const delay = computeBackoffDelay(reconnectAttemptRef.current)
    reconnectAttemptRef.current++

    console.info(`[Telemetry] Reconnecting in ${delay}ms (attempt ${reconnectAttemptRef.current})`)

    reconnectTimeoutRef.current = window.setTimeout(() => {
      reconnectTimeoutRef.current = null
      connect()
    }, delay)
  }, [connect, computeBackoffDelay])

  useEffect(() => {
    connect()

    return () => {
      markUnmounted()
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      wsRef.current?.close()
    }
  }, [connect, markUnmounted])

  return wsRef.current
}
