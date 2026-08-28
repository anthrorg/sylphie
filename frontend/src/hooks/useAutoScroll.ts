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
      // TK-152: this used to hard-set scrollTop (always an instant jump),
      // silently ignoring the `behavior` option entirely. scrollTo() actually
      // honors 'smooth' vs 'auto'.
      el.scrollTo({ top: el.scrollHeight, behavior })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, behavior])
}
