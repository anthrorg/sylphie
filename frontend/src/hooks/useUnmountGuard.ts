import { useEffect, useRef, useCallback } from 'react'

/**
 * Shared unmount-guard for WebSocket (and similar) reconnect loops.
 *
 * The bug this fixes (TK-141 / item 20260702-005): every reconnecting-WS hook
 * cleared its pending reconnect timer and called `socket.close()` on unmount,
 * but never marked the socket's OWN `onclose` handler as moot. That handler's
 * only staleness guard was `wsRef.current !== ws`, which is still FALSE right
 * after unmount (nothing else touched the ref yet) — so the async `onclose`
 * fired after the component was gone, still passed its guard, and called
 * `scheduleReconnect()`. That spins up a brand-new orphan socket that nothing
 * will ever tear down again (a "zombie socket"): duplicate broadcasts land in
 * the global store, turn counts double, and a stray reconnect can even evict
 * the still-visible tab.
 *
 * Fix: an `unmounted` flag, set synchronously in the effect cleanup BEFORE the
 * socket is closed, that every reconnect scheduler must check first.
 */
export function useUnmountGuard() {
  const unmountedRef = useRef(false)

  // Reset on (re)mount — guards StrictMode's mount/unmount/remount cycle and
  // any hook reuse across renders of the same component instance.
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])

  const isUnmounted = useCallback(() => unmountedRef.current, [])

  /** Call synchronously from effect cleanup, before closing the socket. */
  const markUnmounted = useCallback(() => {
    unmountedRef.current = true
  }, [])

  return { isUnmounted, markUnmounted }
}
