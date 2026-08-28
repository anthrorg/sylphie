import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePressureStatus } from './usePressureStatus'

// AC (TK-149): given usePressureStatus with multiple writers, when pressure
// status updates occur, then there is a single source (no write-thrash /
// last-writer-wins race).

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('usePressureStatus — single source of truth (TK-149)', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reflects GET /api/pressure directly, with nothing else able to overwrite it', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ is_connected: true, is_stale: false }),
    }) as unknown as typeof fetch

    const { result } = renderHook(() => usePressureStatus(5000))

    await act(async () => {
      await flushPromises()
    })

    expect(result.current.isConnected).toBe(true)
    expect(result.current.isStale).toBe(false)
    // Exactly one fetch call for the initial poll — no second writer racing it.
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledWith('/api/pressure')
  })

  it('re-polls on the interval and does not thrash between two different writers', async () => {
    let call = 0
    global.fetch = vi.fn().mockImplementation(async () => {
      call++
      return { ok: true, json: async () => ({ is_connected: true, is_stale: call > 1 }) }
    }) as unknown as typeof fetch

    vi.useFakeTimers()
    const { result } = renderHook(() => usePressureStatus(1000))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.isConnected).toBe(true)
    expect(result.current.isStale).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(result.current.isStale).toBe(true)
  })

  it('degrades to disconnected/stale on a failed poll, without any other writer resurrecting it mid-render', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch

    const { result } = renderHook(() => usePressureStatus(5000))

    await act(async () => {
      await flushPromises()
    })

    expect(result.current.isConnected).toBe(false)
    expect(result.current.isStale).toBe(true)
  })
})
