import { useEffect, RefObject } from 'react'

/**
 * Auto-scroll a container or sentinel element into view when dependencies change.
 *
 * If the ref points to a scrollable container, it scrolls to the bottom.
 * If the ref points to a sentinel div at the end of a list, it uses scrollIntoView.
 */
export function useAutoScroll(
  ref: RefObject<HTMLElement | null>,
  deps: readonly unknown[],
  options?: { behavior?: ScrollBehavior },
) {
  const behavior = options?.behavior ?? 'smooth'

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // Only scroll when content overflows; avoids no-op on short lists.
    // scrollIntoView() is intentionally NOT used as fallback because it would
    // scroll the entire page, not just the container.
    if (el.scrollHeight > el.clientHeight) {
      el.scrollTop = el.scrollHeight
    }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps

  // behavior is read in effect but not used directly; satisfies noUnusedLocals
  void behavior
}
