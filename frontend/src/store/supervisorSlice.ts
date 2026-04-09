// ---------------------------------------------------------------------------
// Supervisor store slice — Zustand state for the DeepSeek reasoning supervisor
// ---------------------------------------------------------------------------

import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerdictRating = 'good' | 'acceptable' | 'questionable' | 'wrong'

export interface SupervisorVerdict {
  cycleId: string
  timestamp: string
  rating: VerdictRating
  confidence: number
  reasoning: string
  flagForGuardian: boolean
  flagReason?: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface SupervisorStatus {
  enabled: boolean
  samplingPolicy: {
    sampleRate: number
    burstMode: boolean
    burstUntil?: string | null
  }
  budgetRemaining: number
  budgetUsedToday: number
  totalVerdicts: number
  recentVerdicts: SupervisorVerdict[]
  flaggedCount: number
}

export interface SamplingPolicy {
  sampleRate?: number
  burstMode?: boolean
}

export interface SupervisorIntervention {
  type: 'flag' | 'rollback' | 'freeze'
  cycleId?: string
  reason?: string
}

// ---------------------------------------------------------------------------
// State interface
// ---------------------------------------------------------------------------

const MAX_VERDICTS = 100

interface SupervisorState {
  // Status
  enabled: boolean
  sampleRate: number
  burstMode: boolean
  budgetRemaining: number
  budgetUsedToday: number
  totalVerdicts: number
  flaggedCount: number

  // UI
  panelOpen: boolean

  // Verdicts
  recentVerdicts: SupervisorVerdict[]

  // Actions
  togglePanel: () => void
  setPanelOpen: (open: boolean) => void
  addVerdict: (verdict: SupervisorVerdict) => void
  setStatus: (status: SupervisorStatus) => void
  clearVerdicts: () => void
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSupervisorStore = create<SupervisorState>((set) => ({
  // Initial state
  panelOpen: false,
  enabled: false,
  sampleRate: 10,
  burstMode: false,
  budgetRemaining: 0,
  budgetUsedToday: 0,
  totalVerdicts: 0,
  flaggedCount: 0,
  recentVerdicts: [],

  togglePanel: () => set((prev) => ({ panelOpen: !prev.panelOpen })),
  setPanelOpen: (open) => set({ panelOpen: open }),

  addVerdict: (verdict) =>
    set((prev) => ({
      recentVerdicts: [...prev.recentVerdicts, verdict].slice(-MAX_VERDICTS),
      totalVerdicts: prev.totalVerdicts + 1,
      flaggedCount: prev.flaggedCount + (verdict.flagForGuardian ? 1 : 0),
    })),

  setStatus: (status) =>
    set({
      enabled: status.enabled,
      sampleRate: status.samplingPolicy.sampleRate,
      burstMode: status.samplingPolicy.burstMode,
      budgetRemaining: status.budgetRemaining,
      budgetUsedToday: status.budgetUsedToday,
      totalVerdicts: status.totalVerdicts,
      flaggedCount: status.flaggedCount,
      recentVerdicts: status.recentVerdicts.slice(-MAX_VERDICTS),
    }),

  clearVerdicts: () =>
    set({
      recentVerdicts: [],
      totalVerdicts: 0,
      flaggedCount: 0,
    }),
}))
