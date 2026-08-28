import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MockWebSocket } from './testUtils/mockWebSocket'
import { MockRTCPeerConnection } from './testUtils/mockRTCPeerConnection'

// AC (TK-146): Given an active WebRTC peer connection in a mounted component,
// when the component unmounts or the connection closes, then the
// RTCPeerConnection is closed (no leak) and stale tracks are guarded.
//
// AC (TK-141, applied to useWebRTC): unmounting does not schedule a
// reconnect of the signaling socket.

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('useWebRTC — RTCPeerConnection leak + staleness guard (TK-146) / unmount guard (TK-141)', () => {
  let OriginalWebSocket: typeof WebSocket
  let OriginalRTCPeerConnection: typeof RTCPeerConnection

  beforeEach(() => {
    MockWebSocket.reset()
    MockRTCPeerConnection.reset()
    OriginalWebSocket = global.WebSocket
    OriginalRTCPeerConnection = global.RTCPeerConnection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.WebSocket = MockWebSocket as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.RTCPeerConnection = MockRTCPeerConnection as any

    const track = { stop: vi.fn(), enabled: true, kind: 'video' }
    const mockStream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream
    Object.defineProperty(global.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(mockStream) },
    })
  })

  afterEach(() => {
    global.WebSocket = OriginalWebSocket
    global.RTCPeerConnection = OriginalRTCPeerConnection
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('closes the previous RTCPeerConnection before creating a new one on signaling reconnect', async () => {
    const { useWebRTC } = await import('./useWebRTC')
    const { result } = renderHook(() => useWebRTC({ autoConnect: true }))

    await act(async () => {
      await flushPromises()
    })

    expect(MockWebSocket.instances).toHaveLength(1)
    const firstWs = MockWebSocket.instances[0]

    // Signaling opens -> first RTCPeerConnection is created.
    act(() => { firstWs.onopen?.() })
    expect(MockRTCPeerConnection.instances).toHaveLength(1)
    const firstPc = MockRTCPeerConnection.instances[0]
    expect(firstPc.closed).toBe(false)

    // Signaling drops (pc itself is still "new", not closed) -> reconnect scheduled.
    vi.useFakeTimers()
    act(() => {
      firstWs.simulateClose()
      vi.advanceTimersByTime(35_000)
    })
    vi.useRealTimers()

    expect(MockWebSocket.instances.length).toBeGreaterThan(1)
    const secondWs = MockWebSocket.instances[MockWebSocket.instances.length - 1]

    // Reconnected signaling reopens -> must close the stale pc before making a new one.
    act(() => { secondWs.onopen?.() })

    expect(firstPc.closed).toBe(true) // no leak
    expect(MockRTCPeerConnection.instances.length).toBeGreaterThan(1)
    const secondPc = MockRTCPeerConnection.instances[MockRTCPeerConnection.instances.length - 1]
    expect(secondPc.closed).toBe(false)

    result.current.disconnect()
  })

  it('does not reconnect the signaling socket after unmount', async () => {
    const { useWebRTC } = await import('./useWebRTC')
    const { unmount } = renderHook(() => useWebRTC({ autoConnect: true }))

    await act(async () => {
      await flushPromises()
    })
    expect(MockWebSocket.instances).toHaveLength(1)
    const firstWs = MockWebSocket.instances[0]
    act(() => { firstWs.onopen?.() })
    expect(MockRTCPeerConnection.instances).toHaveLength(1)

    unmount() // closes pc + signaling ws + releases media

    vi.useFakeTimers()
    act(() => {
      firstWs.simulateClose()
      vi.advanceTimersByTime(35_000)
    })
    vi.useRealTimers()

    expect(MockWebSocket.instances).toHaveLength(1)
  })
})
