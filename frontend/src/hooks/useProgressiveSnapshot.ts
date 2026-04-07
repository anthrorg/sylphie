import { useEffect, useCallback, useRef, useState } from 'react'
import type { GraphNode, GraphEdge, GraphSnapshot } from '../types'

// ---------------------------------------------------------------------------
// Progressive graph loader — fetches nodes and edges in pages to avoid
// blocking the main thread with a single enormous JSON parse.
// Falls back to legacy single-fetch when paginated endpoints aren't available.
// ---------------------------------------------------------------------------

const NODE_PAGE_SIZE = 500
const EDGE_PAGE_SIZE = 1000

export interface ProgressiveLoadState {
  /** 0–1 progress fraction */
  progress: number
  /** Human-readable status */
  status: string
  /** True while any fetch is in flight */
  loading: boolean
  /** Final assembled snapshot (null until complete) */
  data: GraphSnapshot | null
  /** Counts from the server */
  totalNodes: number
  totalEdges: number
}

/** Map graph slug to the legacy full-snapshot endpoint path. */
function legacyEndpoint(instance: string): string {
  switch (instance) {
    case 'wkg': return '/api/graph/snapshot'
    case 'okg': return '/api/graph/okg'
    case 'skg': return '/api/graph/skg'
    case 'pkg': return '/api/graph/pkg'
    default:    return `/api/graph/${instance}`
  }
}

/**
 * Progressively loads a graph snapshot in pages.
 *
 * @param instance  Graph slug: 'wkg' | 'okg' | 'skg' | 'pkg'
 * @param pollMs    Re-poll interval in ms (0 = one-shot, no polling)
 */
export function useProgressiveSnapshot(
  instance: string,
  pollMs = 0,
): ProgressiveLoadState {
  const [state, setState] = useState<ProgressiveLoadState>({
    progress: 0,
    status: 'idle',
    loading: false,
    data: null,
    totalNodes: 0,
    totalEdges: 0,
  })

  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<number | null>(null)
  const lastFingerprintRef = useRef('')

  /** Legacy single-fetch fallback. */
  const loadLegacy = useCallback(async (signal: AbortSignal) => {
    setState((s) => ({ ...s, loading: true, progress: 0.5, status: 'Loading...' }))
    const res = await fetch(legacyEndpoint(instance), { signal })
    if (!res.ok || signal.aborted) {
      setState((s) => ({ ...s, loading: false, progress: 0, status: 'Unavailable' }))
      return
    }
    const data = await res.json() as GraphSnapshot
    const nn = data.nodes?.length ?? 0
    const ne = data.edges?.length ?? 0
    lastFingerprintRef.current = `${nn}:${ne}`
    setState({
      progress: 1,
      status: `${nn} nodes, ${ne} edges`,
      loading: false,
      data,
      totalNodes: nn,
      totalEdges: ne,
    })
  }, [instance])

  /** Progressive paginated fetch. Falls back to legacy on 404. */
  const load = useCallback(async () => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    const signal = ac.signal

    setState((s) => ({ ...s, loading: true, progress: 0, status: 'Counting...' }))

    try {
      // ── Step 1: Try paginated count endpoint ──────────────────
      const countRes = await fetch(`/api/graph/${instance}/count`, { signal })

      // If paginated endpoints don't exist (404), fall back to legacy
      if (!countRes.ok) {
        await loadLegacy(signal)
        return
      }

      if (signal.aborted) return
      const { nodes: totalNodes, edges: totalEdges } = await countRes.json()

      // Quick fingerprint check — skip if nothing changed
      const fp = `${totalNodes}:${totalEdges}`
      if (fp === lastFingerprintRef.current) {
        setState((s) => ({ ...s, loading: false, progress: 1, status: 'Up to date' }))
        return
      }

      setState((s) => ({ ...s, totalNodes, totalEdges }))

      const totalWork = totalNodes + totalEdges
      let loaded = 0

      // ── Step 2: Fetch node pages ──────────────────────────────
      const allNodes: GraphNode[] = []
      for (let skip = 0; skip < totalNodes; skip += NODE_PAGE_SIZE) {
        if (signal.aborted) return
        const limit = Math.min(NODE_PAGE_SIZE, totalNodes - skip)
        setState((s) => ({
          ...s,
          status: `Nodes ${skip}–${skip + limit} / ${totalNodes}`,
          progress: totalWork > 0 ? loaded / totalWork : 0,
        }))

        const res = await fetch(
          `/api/graph/${instance}/nodes?skip=${skip}&limit=${limit}`,
          { signal },
        )
        if (!res.ok) {
          // Paginated nodes endpoint failed — fall back to legacy
          await loadLegacy(signal)
          return
        }
        if (signal.aborted) return
        const page = await res.json()
        allNodes.push(...(page.nodes as GraphNode[]))
        loaded += page.nodes.length

        // Yield to browser between pages
        await new Promise((r) => requestAnimationFrame(r))
      }

      // ── Step 3: Fetch edge pages ──────────────────────────────
      const allEdges: GraphEdge[] = []
      for (let skip = 0; skip < totalEdges; skip += EDGE_PAGE_SIZE) {
        if (signal.aborted) return
        const limit = Math.min(EDGE_PAGE_SIZE, totalEdges - skip)
        setState((s) => ({
          ...s,
          status: `Edges ${skip}–${skip + limit} / ${totalEdges}`,
          progress: totalWork > 0 ? loaded / totalWork : 0,
        }))

        const res = await fetch(
          `/api/graph/${instance}/edges?skip=${skip}&limit=${limit}`,
          { signal },
        )
        if (!res.ok) {
          await loadLegacy(signal)
          return
        }
        if (signal.aborted) return
        const page = await res.json()
        allEdges.push(...(page.edges as GraphEdge[]))
        loaded += page.edges.length

        await new Promise((r) => requestAnimationFrame(r))
      }

      // ── Step 4: Assemble final snapshot ───────────────────────
      lastFingerprintRef.current = fp
      setState({
        progress: 1,
        status: `${allNodes.length} nodes, ${allEdges.length} edges`,
        loading: false,
        data: { nodes: allNodes, edges: allEdges },
        totalNodes,
        totalEdges,
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      // Network error — try legacy as last resort
      try {
        await loadLegacy(signal)
      } catch {
        setState((s) => ({ ...s, loading: false, status: 'Load failed' }))
      }
    }
  }, [instance, loadLegacy])

  useEffect(() => {
    load()
    if (pollMs > 0) {
      timerRef.current = window.setInterval(load, pollMs)
    }
    return () => {
      abortRef.current?.abort()
      if (timerRef.current !== null) clearInterval(timerRef.current)
    }
  }, [load, pollMs])

  return state
}
