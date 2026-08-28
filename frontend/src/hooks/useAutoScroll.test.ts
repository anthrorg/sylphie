import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { useAutoScroll } from './useAutoScroll'

// AC (TK-152): useAutoScroll called with a behavior argument, when behavior
// is 'auto' vs 'smooth', then the difference is observed/honored.

function makeOverflowingEl(): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true })
  el.scrollTo = vi.fn() as unknown as typeof el.scrollTo
  return el
}

describe('useAutoScroll — honors the behavior option (TK-152)', () => {
  it('passes behavior:"smooth" (the default) through to scrollTo', () => {
    const el = makeOverflowingEl()
    renderHook(() => {
      const ref = useRef(el)
      useAutoScroll(ref, [1])
    })

    expect(el.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' })
  })

  it('passes behavior:"auto" through to scrollTo when explicitly requested', () => {
    const el = makeOverflowingEl()
    renderHook(() => {
      const ref = useRef(el)
      useAutoScroll(ref, [1], { behavior: 'auto' })
    })

    expect(el.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' })
  })

  it('does not scroll at all when content does not overflow', () => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'scrollHeight', { value: 100, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true })
    el.scrollTo = vi.fn() as unknown as typeof el.scrollTo

    renderHook(() => {
      const ref = useRef(el)
      useAutoScroll(ref, [1])
    })

    expect(el.scrollTo).not.toHaveBeenCalled()
  })
})
