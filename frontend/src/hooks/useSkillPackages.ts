import { useState, useCallback } from 'react'
import { useAppStore } from '../store'
import { SkillDto, SkillUploadResponse, SkillResetResponse } from '../types'

interface UploadStatus {
  type: 'success' | 'error'
  message: string
}

export interface ConceptUploadForm {
  label: string
  type: string
  properties: Record<string, unknown>
}

interface UseSkillPackagesReturn {
  isUploading: boolean
  uploadStatus: UploadStatus | null
  clearStatus: () => void
  loadSkills: () => Promise<void>
  uploadConcept: (form: ConceptUploadForm) => Promise<void>
  deactivateSkill: (id: string) => Promise<void>
  resetGraph: (scope: 'hard' | 'experience') => Promise<void>
}

export function useSkillPackages(): UseSkillPackagesReturn {
  const [isUploading, setIsUploading] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null)

  const { setSkills, setGraphData, setGraphStats } = useAppStore()

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

  const loadSkills = useCallback(async () => {
    try {
      const response = await fetch('/api/skills')
      const result = await response.json()
      // GET /api/skills returns { skills: SkillDto[], total, activeCount, type1Count }
      setSkills(result.skills || [])
    } catch (error) {
      console.error('Failed to load skills:', error)
    }
  }, [setSkills])

  const uploadConcept = useCallback(async (form: ConceptUploadForm) => {
    setIsUploading(true)
    setUploadStatus(null)
    try {
      const response = await fetch('/api/skills/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: form.label,
          type: form.type,
          properties: form.properties,
        }),
      })
      const result: SkillUploadResponse = await response.json()
      if (response.ok && result.skill) {
        setUploadStatus({
          type: 'success',
          message: `Uploaded "${result.skill.label}" (${result.skill.type}) — provenance: ${result.enforcedProvenance}, confidence: ${result.enforcedConfidence}`,
        })
        await loadSkills()
        await refreshGraphState()
      } else {
        const errMsg = (result as unknown as { message?: string }).message || 'Upload failed'
        setUploadStatus({ type: 'error', message: errMsg })
      }
    } catch (_error) {
      setUploadStatus({ type: 'error', message: 'Network error during concept upload' })
    }
    setIsUploading(false)
  }, [loadSkills, refreshGraphState])

  const deactivateSkill = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' })
      const result: SkillDto | { message?: string } = await response.json()
      if (response.ok && 'id' in result) {
        setUploadStatus({ type: 'success', message: `Deactivated skill "${(result as SkillDto).label}"` })
        await loadSkills()
        await refreshGraphState()
      } else {
        setUploadStatus({ type: 'error', message: (result as { message?: string }).message || 'Deactivation failed' })
      }
    } catch (_error) {
      setUploadStatus({ type: 'error', message: 'Network error during deactivation' })
    }
  }, [loadSkills, refreshGraphState])

  const resetGraph = useCallback(async (scope: 'hard' | 'experience') => {
    try {
      const response = await fetch('/api/skills/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, confirm: true }),
      })
      const result: SkillResetResponse = await response.json()
      if (result.success) {
        setUploadStatus({
          type: 'success',
          message: `${result.operation ?? scope} completed (${result.nodes_deleted ?? 0} nodes, ${result.edges_deleted ?? 0} edges)`,
        })
        if (scope === 'hard') await loadSkills()
        await refreshGraphState()
      } else {
        setUploadStatus({ type: 'error', message: result.message || 'Reset failed' })
      }
    } catch (_error) {
      setUploadStatus({ type: 'error', message: 'Network error during reset' })
    }
  }, [loadSkills, refreshGraphState])

  const clearStatus = useCallback(() => setUploadStatus(null), [])

  return { isUploading, uploadStatus, clearStatus, loadSkills, uploadConcept, deactivateSkill, resetGraph }
}
