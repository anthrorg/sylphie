import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useUnmountGuard } from './useUnmountGuard'

describe('useUnmountGuard', () => {
  it('reports not unmounted while mounted', () => {
    const { result } = renderHook(() => useUnmountGuard())
    expect(result.current.isUnmounted()).toBe(false)
  })

  it('reports unmounted after the component unmounts', () => {
    const { result, unmount } = renderHook(() => useUnmountGuard())
    expect(result.current.isUnmounted()).toBe(false)
    unmount()
    expect(result.current.isUnmounted()).toBe(true)
  })

  it('markUnmounted() flips the flag synchronously (for explicit effect-cleanup ordering)', () => {
    const { result } = renderHook(() => useUnmountGuard())
    expect(result.current.isUnmounted()).toBe(false)
    result.current.markUnmounted()
    expect(result.current.isUnmounted()).toBe(true)
  })
})
