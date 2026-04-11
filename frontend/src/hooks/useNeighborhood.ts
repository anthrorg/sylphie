import { useState, useEffect, useRef } from 'react'
import type { GraphSnapshot } from '../types'

interface NeighborhoodState {
  data: GraphSnapshot | null
  loading: boolean
  truncated: boolean
}

export function useNeighborhood(nodeId: string | null, hops: number): NeighborhoodState {
  const [state, setState] = useState<NeighborhoodState>({
    data: null,
    loading: false,
    truncated: false,
  })
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    abortRef.current?.abort()

    if (!nodeId) {
      setState({ data: null, loading: false, truncated: false })
      return
    }

    setState((prev) => ({ ...prev, loading: true }))
    const controller = new AbortController()
    abortRef.current = controller

    const fetchNeighborhood = async () => {
      try {
        const res = await fetch(
          `/api/graph/wkg/neighborhood?nodeId=${encodeURIComponent(nodeId)}&hops=${hops}`,
          { signal: controller.signal },
        )
        if (!res.ok) throw new Error(res.statusText)
        const data = await res.json()
        setState({
          data: { nodes: data.nodes, edges: data.edges },
          loading: false,
          truncated: data.truncated ?? false,
        })
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setState({ data: null, loading: false, truncated: false })
        }
      }
    }

    // Small delay to debounce rapid node-click drilling
    const timeout = setTimeout(fetchNeighborhood, 150)
    return () => {
      clearTimeout(timeout)
      controller.abort()
    }
  }, [nodeId, hops])

  return state
}
