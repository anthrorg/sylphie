import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../store'
import { GraphDelta, ConversationMessage, TelemetryMessage } from '../types'

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

  const { setWsState, setGraphData, setGraphStats, resetStasisCount, setSessionStats } =
    useAppStore()

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
        setWsState('graph', 'reconnecting')
        scheduleReconnect()
      }
    } catch (error) {
      console.error('[Graph] Could not create WebSocket:', error)
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
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current)
      }
      wsRef.current?.close()
    }
  }, [connect, fetchSnapshot])

  return wsRef.current
}

export function useConversationWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)

  const { setWsState, addMessage, incrementTurns } = useAppStore()

  const computeBackoffDelay = useCallback((attempt: number) => {
    const base = Math.min(1000 * Math.pow(2, attempt), 30000)
    const jitter = 0.8 + Math.random() * 0.4
    return Math.round(base * jitter)
  }, [])

  const sendMessage = useCallback((message: unknown) => {
    console.info('[Conversation] sendMessage called', {
      readyState: wsRef.current?.readyState,
      readyStateLabel: wsRef.current
        ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][wsRef.current.readyState]
        : 'null',
      payload: message,
    })
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const serialized = JSON.stringify(message)
      console.info('[Conversation] >>> SENDING:', serialized)
      wsRef.current.send(serialized)
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

    if (wsRef.current?.readyState !== WebSocket.CLOSED) {
      wsRef.current?.close()
    }

    try {
      const connId = Math.random().toString(36).slice(2, 8)
      console.info(`[Conversation] Creating new WebSocket (connId=${connId})`, {
        url: `${WS_BASE}/ws/conversation?protocol=cobeing-v1`,
      })
      const ws = new WebSocket(`${WS_BASE}/ws/conversation?protocol=cobeing-v1`)
      wsRef.current = ws
      setWsState('conversation', 'reconnecting')

      ws.onopen = () => {
        if (wsRef.current !== ws) return
        console.info('[Conversation] WebSocket opened', { url: ws.url, protocol: ws.protocol })
        setWsState('conversation', 'connected')
        reconnectAttemptRef.current = 0
      }

      ws.onmessage = (event) => {
        console.info('[Conversation] <<< RECEIVED:', event.data)
        try {
          const message = JSON.parse(event.data)
          console.info('[Conversation] Parsed message:', {
            type: message.type,
            hasContent: !!message.content,
            keys: Object.keys(message),
          })

          // Server echoes back an ack for guardian inputs; skip since we already
          // optimistically rendered the user's message in ConversationPanel.
          if (message.type === 'input_ack') {
            return
          }

          // cobeing-v1: system_status with no text is the session-start confirmation
          // or isThinking:false frame — no content to render in the conversation feed.
          if (message.type === 'system_status' && !message.text) {
            return
          }

          addMessage(message as ConversationMessage)

          // cobeing-v1 sends Sylphie's replies as 'cb_speech'; native protocol sends 'response'.
          // Both count as completed turns for session statistics and stasis detection.
          if (message.type === 'response' || message.type === 'cb_speech') {
            incrementTurns()
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
        setWsState('conversation', 'reconnecting')
        scheduleReconnect()
      }
    } catch (error) {
      console.error('[Conversation] Could not create WebSocket:', error)
      setWsState('conversation', 'reconnecting')
      scheduleReconnect()
    }
  }, [setWsState, addMessage, incrementTurns])

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
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      wsRef.current?.close()
    }
  }, [connect])

  return { ws: wsRef.current, sendMessage, sendTextMessage }
}

export function useTelemetryWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)

  const { setWsState, updateTelemetry, addPredictionToHistory, addInnerMonologue, addSystemLog } =
    useAppStore()

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

            case 'prediction_result':
              addPredictionToHistory(message.action, message.accuracy)
              break

            case 'maintenance_cycle':
              addInnerMonologue({
                // Verbatim TimescaleDB event payload — no LLM summarisation
                text: `maintenance_cycle: jobs_run=${message.jobs_run} committed=${message.committed} phrase_consolidation=${message.phrase_consolidation}`,
                timestamp: new Date(message.timestamp * 1000).toISOString(),
                rawPayload: event.data,
              })
              addSystemLog({
                text: `[maintenance] ${message.jobs_run} jobs, ${message.committed} committed${message.phrase_consolidation ? ', phrases consolidated' : ''}`,
                timestamp: ts,
                level: message.committed > 0 ? 'info' : 'warn',
              })
              break

            case 'state_transition':
              addSystemLog({
                text: `[state] ${message.from_state} → ${message.to_state} (${message.event})`,
                timestamp: ts,
                level: 'info',
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
        setWsState('telemetry', 'reconnecting')
        scheduleReconnect()
      }
    } catch (error) {
      console.error('[Telemetry] Could not create WebSocket:', error)
      setWsState('telemetry', 'reconnecting')
      scheduleReconnect()
    }
  }, [setWsState, updateTelemetry, addPredictionToHistory, addInnerMonologue, addSystemLog])

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
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      wsRef.current?.close()
    }
  }, [connect])

  return wsRef.current
}
