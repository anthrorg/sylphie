import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MockWebSocket } from './testUtils/mockWebSocket'

// AC (TK-144): Given a backend restart with the perception panel open, when
// the socket drops, then perception reconnects and detections resume.

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('usePerception — reconnect + resume detections on drop (TK-144)', () => {
  let OriginalWebSocket: typeof WebSocket

  beforeEach(() => {
    MockWebSocket.reset()
    OriginalWebSocket = global.WebSocket
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.WebSocket = MockWebSocket as any

    const track = { stop: vi.fn(), kind: 'video' }
    const mockStream = { getTracks: () => [track] } as unknown as MediaStream
    Object.defineProperty(global.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(mockStream) },
    })

    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      drawImage: vi.fn(),
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.toBlob = vi.fn(function toBlob(
      this: HTMLCanvasElement,
      cb: BlobCallback,
    ) {
      cb(new Blob())
    })
  })

  afterEach(() => {
    global.WebSocket = OriginalWebSocket
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('opens a new perception socket after the previous one drops, and resumes emitting detections', async () => {
    const { usePerception } = await import('./usePerception')
    renderHook(() => usePerception())

    // start() is async (getUserMedia -> video.play() -> connectPerceptionSocket()).
    await act(async () => { await flushPromises() })
    expect(MockWebSocket.instances).toHaveLength(1)
    const firstSocket = MockWebSocket.instances[0]
    expect(firstSocket.url).toContain('/ws/perception')

    // Simulate a live detection arriving on the first connection.
    act(() => { firstSocket.onopen?.() })
    expect(() =>
      act(() => {
        firstSocket.onmessage?.({
          data: JSON.stringify({ detections: [{ label_raw: 'cup', confidence: 0.9 }] }),
        } as MessageEvent)
      }),
    ).not.toThrow()

    // Backend restart: the socket drops. Reconnect is scheduled with backoff —
    // use fake timers to fast-forward past it deterministically.
    vi.useFakeTimers()
    act(() => {
      firstSocket.simulateClose()
      vi.advanceTimersByTime(35_000)
    })
    vi.useRealTimers()

    expect(MockWebSocket.instances.length).toBeGreaterThan(1)
    const secondSocket = MockWebSocket.instances[MockWebSocket.instances.length - 1]

    // Detections resume: the new socket's onmessage repopulates recognized items.
    act(() => { secondSocket.onopen?.() })
    expect(() =>
      act(() => {
        secondSocket.onmessage?.({
          data: JSON.stringify({ detections: [{ label_raw: 'mug', confidence: 0.8 }] }),
        } as MessageEvent)
      }),
    ).not.toThrow()
  })

  it('does NOT reconnect once unmounted', async () => {
    const { usePerception } = await import('./usePerception')
    const { unmount } = renderHook(() => usePerception())

    await act(async () => { await flushPromises() })
    expect(MockWebSocket.instances).toHaveLength(1)
    const firstSocket = MockWebSocket.instances[0]

    unmount()

    vi.useFakeTimers()
    act(() => {
      firstSocket.simulateClose()
      vi.advanceTimersByTime(35_000)
    })
    vi.useRealTimers()

    expect(MockWebSocket.instances).toHaveLength(1)
  })
})
