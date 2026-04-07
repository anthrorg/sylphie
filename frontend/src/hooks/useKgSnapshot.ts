import { useEffect, useCallback, useRef } from 'react'
import { useAppStore } from '../store'

/**
 * Periodically fetches the OKG and SKG graph snapshots via REST.
 * Unlike the WKG (which uses a WebSocket for live deltas), the OKG/SKG
 * change infrequently enough that polling every 10s is sufficient.
 */
const POLL_INTERVAL_MS = 10_000

export function useOkgSnapshot() {
  const setOkgData = useAppStore((s) => s.setOkgData)
  const setOkgStats = useAppStore((s) => s.setOkgStats)
  const timerRef = useRef<number | null>(null)

  const fetchOkg = useCallback(async () => {
    try {
      const res = await fetch('/api/graph/okg')
      if (!res.ok) return
      const data = await res.json()
      setOkgData(data)
      setOkgStats({ nodes: data.nodes?.length ?? 0, edges: data.edges?.length ?? 0 })
    } catch {
      // Silently fail — OKG may not be available
    }
  }, [setOkgData, setOkgStats])

  useEffect(() => {
    fetchOkg()
    timerRef.current = window.setInterval(fetchOkg, POLL_INTERVAL_MS)
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current)
    }
  }, [fetchOkg])
}

export function useSkgSnapshot() {
  const setSkgData = useAppStore((s) => s.setSkgData)
  const setSkgStats = useAppStore((s) => s.setSkgStats)
  const timerRef = useRef<number | null>(null)

  const fetchSkg = useCallback(async () => {
    try {
      const res = await fetch('/api/graph/skg')
      if (!res.ok) return
      const data = await res.json()
      setSkgData(data)
      setSkgStats({ nodes: data.nodes?.length ?? 0, edges: data.edges?.length ?? 0 })
    } catch {
      // Silently fail — SKG may not be available
    }
  }, [setSkgData, setSkgStats])

  useEffect(() => {
    fetchSkg()
    timerRef.current = window.setInterval(fetchSkg, POLL_INTERVAL_MS)
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current)
    }
  }, [fetchSkg])
}

/**
 * Fetches the PKG (Package/Codebase Knowledge Graph) snapshot.
 * Polls less frequently (30s) since codebase structure changes rarely at runtime.
 */
const PKG_POLL_INTERVAL_MS = 30_000

export function usePkgSnapshot() {
  const setPkgData = useAppStore((s) => s.setPkgData)
  const setPkgStats = useAppStore((s) => s.setPkgStats)
  const timerRef = useRef<number | null>(null)

  const fetchPkg = useCallback(async () => {
    try {
      const res = await fetch('/api/graph/pkg')
      if (!res.ok) return
      const data = await res.json()
      setPkgData(data)
      setPkgStats({ nodes: data.nodes?.length ?? 0, edges: data.edges?.length ?? 0 })
    } catch {
      // Silently fail — PKG Neo4j may not be running
    }
  }, [setPkgData, setPkgStats])

  useEffect(() => {
    fetchPkg()
    timerRef.current = window.setInterval(fetchPkg, PKG_POLL_INTERVAL_MS)
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current)
    }
  }, [fetchPkg])
}
