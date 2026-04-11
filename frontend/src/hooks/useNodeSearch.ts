import { useState, useEffect, useRef } from 'react'
import type { SearchNodeResult } from '../types'

export function useNodeSearch(query: string) {
  const [results, setResults] = useState<SearchNodeResult[]>([])
  const [loading, setLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    // Cancel any in-flight request
    abortRef.current?.abort()

    if (query.trim().length < 2) {
      setResults([])
      setLoading(false)
      return
    }

    setLoading(true)
    const timeout = setTimeout(async () => {
      const controller = new AbortController()
      abortRef.current = controller

      try {
        const res = await fetch(
          `/api/graph/wkg/search?q=${encodeURIComponent(query.trim())}&limit=8`,
          { signal: controller.signal },
        )
        if (!res.ok) throw new Error(res.statusText)
        const data: SearchNodeResult[] = await res.json()
        setResults(data)
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setResults([])
        }
      } finally {
        setLoading(false)
      }
    }, 300) // 300ms debounce

    return () => {
      clearTimeout(timeout)
      abortRef.current?.abort()
    }
  }, [query])

  return { results, loading }
}
