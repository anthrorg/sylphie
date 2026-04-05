import { useState, useCallback } from 'react'
import { useAppStore } from '../store'

interface ResetStatus {
  type: 'success' | 'error'
  message: string
}

interface UseSkillPackagesReturn {
  isResetting: boolean
  resetStatus: ResetStatus | null
  clearStatus: () => void
  resetGraph: () => Promise<void>
}

export function useSkillPackages(): UseSkillPackagesReturn {
  const [isResetting, setIsResetting] = useState(false)
  const [resetStatus, setResetStatus] = useState<ResetStatus | null>(null)

  const { setGraphData, setGraphStats } = useAppStore()

  const refreshGraphState = useCallback(async () => {
    try {
      const response = await fetch('/api/graph/snapshot')
      const snapshot = await response.json()
      const nodes = snapshot.nodes || []
      const edges = snapshot.edges || []
      setGraphData({ nodes, edges })
      setGraphStats({ nodes: nodes.length, edges: edges.length })
    } catch (error) {
      console.error('Failed to refresh graph state:', error)
    }
  }, [setGraphData, setGraphStats])

  const resetGraph = useCallback(async () => {
    setIsResetting(true)
    setResetStatus(null)
    try {
      const response = await fetch('/api/skills/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      })
      const result = await response.json()
      if (result.success) {
        setResetStatus({
          type: 'success',
          message: `Reset complete — deleted ${result.nodes_deleted ?? 0} nodes, ${result.edges_deleted ?? 0} edges. Re-bootstrapped ${result.nodes_created ?? 0} nodes.`,
        })
        await refreshGraphState()
      } else {
        setResetStatus({ type: 'error', message: result.message || 'Reset failed' })
      }
    } catch (_error) {
      setResetStatus({ type: 'error', message: 'Network error during reset' })
    }
    setIsResetting(false)
  }, [refreshGraphState])

  const clearStatus = useCallback(() => setResetStatus(null), [])

  return { isResetting, resetStatus, clearStatus, resetGraph }
}
