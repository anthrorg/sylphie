import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { MockWebSocket } from './testUtils/mockWebSocket'

// AC (TK-141): Given a mounted WS panel with a mock socket, when its
// component unmounts and the async onclose fires, no orphan socket remains
// and onclose does NOT call scheduleReconnect.

describe('useSupervisorWebSocket — unmount-reconnect zombie socket (TK-141)', () => {
  let OriginalWebSocket: typeof WebSocket

  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.reset()
    OriginalWebSocket = global.WebSocket
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.WebSocket = MockWebSocket as any
  })

  afterEach(() => {
    global.WebSocket = OriginalWebSocket
    vi.useRealTimers()
  })

  it('does not schedule a reconnect when onclose fires after unmount', async () => {
    const { useSupervisorWebSocket } = await import('./useSupervisorWebSocket')
    const { unmount } = renderHook(() => useSupervisorWebSocket())

    expect(MockWebSocket.instances).toHaveLength(1)
    const firstSocket = MockWebSocket.instances[0]

    // Unmount BEFORE the socket's close event ever fires — this is the race
    // the bug lived in: cleanup nulled the timer and called close(), but the
    // async onclose handler still ran afterward and (pre-fix) would pass its
    // staleness guard and call scheduleReconnect().
    unmount()

    // Now the async close event arrives (as it would in the real browser).
    firstSocket.simulateClose(1006)

    // Let any (incorrectly) scheduled reconnect timer fire.
    vi.advanceTimersByTime(60_000)

    // No new socket should have been created — the reconnect must have been
    // short-circuited by the unmount guard.
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('DOES reconnect on close while still mounted (baseline — reconnect logic still works)', async () => {
    const { useSupervisorWebSocket } = await import('./useSupervisorWebSocket')
    renderHook(() => useSupervisorWebSocket())

    expect(MockWebSocket.instances).toHaveLength(1)
    const firstSocket = MockWebSocket.instances[0]

    firstSocket.simulateClose(1006)
    vi.advanceTimersByTime(60_000)

    expect(MockWebSocket.instances.length).toBeGreaterThan(1)
  })
})
