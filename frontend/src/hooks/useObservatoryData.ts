import { useState, useCallback } from 'react'

// ---------------------------------------------------------------------------
// Sylphie backend response shapes (from /api/metrics/observatory/*)
// ---------------------------------------------------------------------------

interface SylphieVocabDay {
  date: string
  newNodes: number
  cumulativeTotal: number
  byLabel: Record<string, number>
  byProvenance: Record<string, number>
}

interface SylphieVocabResponse {
  days: SylphieVocabDay[]
}

interface SylphieDriveSession {
  sessionId: string
  drives: Record<string, number>
  sampleCount: number
}

interface SylphieDriveResponse {
  sessions: SylphieDriveSession[]
}

interface SylphieActionSession {
  sessionId: string
  uniqueActionTypes: number
  totalActions: number
  diversityIndex: number
}

interface SylphieActionResponse {
  sessions: SylphieActionSession[]
}

interface SylphieDevSession {
  sessionId: string
  type1Count: number
  type2Count: number
  ratio: number
}

interface SylphieDevResponse {
  sessions: SylphieDevSession[]
  overall: {
    stage: string
    type1Pct: number
  }
}

interface SylphieSessionRow {
  id: string
  startedAt: string
  endedAt: string | null
  metricsSnapshot: Record<string, unknown> | null
}

interface SylphieSessionResponse {
  sessions: SylphieSessionRow[]
}

interface SylphieComprehensionSession {
  sessionId: string
  mae: number
  sampleCount: number
}

interface SylphieComprehensionResponse {
  sessions: SylphieComprehensionSession[]
}

interface SylphiePhraseResponse {
  totalUtterances: number
  recognizedCount: number
  ratio: number
  byProvenance: Record<string, number>
}

// ---------------------------------------------------------------------------
// Adapted shapes consumed by ObservatoryDashboard
// ---------------------------------------------------------------------------

// Vocabulary: component reads .phrase_nodes and .can_produce_count per session.
// Sylphie has daily granularity, not per-session. We map each day to an entry,
// using cumulativeTotal for phrase_nodes and counting GUARDIAN-provenance nodes
// as a proxy for can_produce_count.
export interface VocabEntry {
  phrase_nodes: number
  can_produce_count: number
  date: string
}

// Drive: component reads .drives (Record<string, number>) per session — matches Sylphie directly.
export interface DriveEntry {
  drives: Record<string, number>
  sessionId: string
}

// Action: component reads .unique_action_types and .total_actions per session.
export interface ActionEntry {
  unique_action_types: number
  total_actions: number
  diversity_index: number
  sessionId: string
}

// Developmental stage: component reads devStage.overall.stage and devStage.overall.type1Pct.
export interface DevStage {
  overall: {
    stage: string
    type1Pct: number
  }
  sessions: SylphieDevSession[]
}

// Session comparison: component reads session_id, duration_seconds, total_cycles,
// avg_pressure, phrases_created, total_speech_acts.
// Sylphie provides id, startedAt, endedAt, metricsSnapshot.
// We extract what we can from metricsSnapshot; unknowns default to undefined.
export interface SessionEntry {
  session_id: string
  duration_seconds: number | undefined
  total_cycles: number | undefined
  avg_pressure: number | undefined
  phrases_created: number | undefined
  total_speech_acts: number | undefined
}

// Comprehension: component reads .avg_confidence and .producing_count per session.
// Sylphie provides mae and sampleCount. We expose mae as avg_confidence (inverted:
// lower MAE means higher comprehension, so avg_confidence = 1 - mae, clamped).
export interface ComprehensionEntry {
  avg_confidence: number
  producing_count: number
  sessionId: string
}

// Phrase ratio: component iterates phraseRatioData as an array reading .ratio.
// Sylphie returns a single object. We wrap it in a one-element array.
export interface PhraseRatioEntry {
  ratio: number
  totalUtterances: number
  recognizedCount: number
  byProvenance: Record<string, number>
}

// Experiential provenance ratio — derived from phrase-recognition byProvenance.
// SENSOR + GUARDIAN + INFERENCE / total Utterances above threshold.
export interface ExperientialProvenance {
  ratio: number        // 0–1, fraction of utterances from non-LLM provenance
  totalUtterances: number
  byProvenance: Record<string, number>
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

function adaptVocab(response: SylphieVocabResponse): VocabEntry[] {
  return response.days.map((day) => ({
    phrase_nodes: day.cumulativeTotal,
    can_produce_count: day.byProvenance['GUARDIAN'] ?? 0,
    date: day.date,
  }))
}

function adaptDrive(response: SylphieDriveResponse): DriveEntry[] {
  return response.sessions.map((s) => ({
    drives: s.drives,
    sessionId: s.sessionId,
  }))
}

function adaptAction(response: SylphieActionResponse): ActionEntry[] {
  return response.sessions.map((s) => ({
    unique_action_types: s.uniqueActionTypes,
    total_actions: s.totalActions,
    diversity_index: s.diversityIndex,
    sessionId: s.sessionId,
  }))
}

function adaptSession(response: SylphieSessionResponse): SessionEntry[] {
  return response.sessions.map((s) => {
    const snap = s.metricsSnapshot ?? {}
    const startedAt = new Date(s.startedAt).getTime()
    const endedAt = s.endedAt ? new Date(s.endedAt).getTime() : undefined
    const duration_seconds = endedAt !== undefined ? Math.round((endedAt - startedAt) / 1000) : undefined

    return {
      session_id: s.id,
      duration_seconds,
      total_cycles: typeof snap['totalCycles'] === 'number' ? snap['totalCycles'] : undefined,
      avg_pressure: typeof snap['avgPressure'] === 'number' ? snap['avgPressure'] : undefined,
      phrases_created: typeof snap['phrasesCreated'] === 'number' ? snap['phrasesCreated'] : undefined,
      total_speech_acts: typeof snap['totalSpeechActs'] === 'number' ? snap['totalSpeechActs'] : undefined,
    }
  })
}

function adaptComprehension(response: SylphieComprehensionResponse): ComprehensionEntry[] {
  return response.sessions.map((s) => ({
    // MAE is an error metric (lower = better). Convert to a confidence-style value.
    avg_confidence: Math.max(0, Math.min(1, 1 - s.mae)),
    producing_count: s.sampleCount,
    sessionId: s.sessionId,
  }))
}

function adaptPhraseRatio(response: SylphiePhraseResponse): PhraseRatioEntry[] {
  // Single aggregate object — wrap in array so the chart can render it
  return [
    {
      ratio: response.ratio,
      totalUtterances: response.totalUtterances,
      recognizedCount: response.recognizedCount,
      byProvenance: response.byProvenance,
    },
  ]
}

function adaptExperientialProvenance(response: SylphiePhraseResponse): ExperientialProvenance {
  const bp = response.byProvenance
  const experiential = (bp['SENSOR'] ?? 0) + (bp['GUARDIAN'] ?? 0) + (bp['INFERENCE'] ?? 0)
  const total = response.totalUtterances > 0 ? response.totalUtterances : 1
  return {
    ratio: Math.min(1, experiential / total),
    totalUtterances: response.totalUtterances,
    byProvenance: bp,
  }
}

// ---------------------------------------------------------------------------
// Empty fallbacks (returned on endpoint failure)
// ---------------------------------------------------------------------------

const EMPTY_VOCAB_RESPONSE: SylphieVocabResponse = { days: [] }
const EMPTY_DRIVE_RESPONSE: SylphieDriveResponse = { sessions: [] }
const EMPTY_ACTION_RESPONSE: SylphieActionResponse = { sessions: [] }
const EMPTY_DEV_RESPONSE: SylphieDevResponse = { sessions: [], overall: { stage: 'pre-autonomy', type1Pct: 0 } }
const EMPTY_SESSION_RESPONSE: SylphieSessionResponse = { sessions: [] }
const EMPTY_COMPREHENSION_RESPONSE: SylphieComprehensionResponse = { sessions: [] }
const EMPTY_PHRASE_RESPONSE: SylphiePhraseResponse = { totalUtterances: 0, recognizedCount: 0, ratio: 0, byProvenance: {} }

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseObservatoryDataReturn {
  loading: boolean
  error: string | null
  vocabData: VocabEntry[]
  driveData: DriveEntry[]
  actionData: ActionEntry[]
  devStage: DevStage | null
  sessionData: SessionEntry[]
  comprehensionData: ComprehensionEntry[]
  phraseRatioData: PhraseRatioEntry[]
  experientialProvenance: ExperientialProvenance | null
  hasData: boolean
  fetchAll: () => Promise<void>
}

/**
 * Fetches data from Sylphie's /api/metrics/observatory/* endpoints (via Vite
 * proxy to http://localhost:3000). Each endpoint is fetched independently so
 * that a single failure does not break the entire dashboard.
 */
export function useObservatoryData(): UseObservatoryDataReturn {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [vocabData, setVocabData] = useState<VocabEntry[]>([])
  const [driveData, setDriveData] = useState<DriveEntry[]>([])
  const [actionData, setActionData] = useState<ActionEntry[]>([])
  const [devStage, setDevStage] = useState<DevStage | null>(null)
  const [sessionData, setSessionData] = useState<SessionEntry[]>([])
  const [comprehensionData, setComprehensionData] = useState<ComprehensionEntry[]>([])
  const [phraseRatioData, setPhraseRatioData] = useState<PhraseRatioEntry[]>([])
  const [experientialProvenance, setExperientialProvenance] = useState<ExperientialProvenance | null>(null)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)

    // Helper: fetch one endpoint and return parsed JSON, or the empty fallback on any error.
    // Each endpoint is independent — a 404 or 500 on one does not affect the others.
    async function fetchEndpoint<T>(path: string, fallback: T): Promise<T> {
      try {
        const res = await fetch(`/api/metrics/observatory/${path}`)
        if (!res.ok) return fallback
        const data: unknown = await res.json()
        if (data === null || typeof data !== 'object') return fallback
        return data as T
      } catch {
        return fallback
      }
    }

    try {
      const [vocab, drive, action, dev, session, comprehension, phrase] = await Promise.all([
        fetchEndpoint<SylphieVocabResponse>('vocabulary-growth', EMPTY_VOCAB_RESPONSE),
        fetchEndpoint<SylphieDriveResponse>('drive-evolution', EMPTY_DRIVE_RESPONSE),
        fetchEndpoint<SylphieActionResponse>('action-diversity', EMPTY_ACTION_RESPONSE),
        fetchEndpoint<SylphieDevResponse>('developmental-stage', EMPTY_DEV_RESPONSE),
        fetchEndpoint<SylphieSessionResponse>('session-comparison', EMPTY_SESSION_RESPONSE),
        fetchEndpoint<SylphieComprehensionResponse>('comprehension-accuracy', EMPTY_COMPREHENSION_RESPONSE),
        fetchEndpoint<SylphiePhraseResponse>('phrase-recognition', EMPTY_PHRASE_RESPONSE),
      ])

      setVocabData(adaptVocab(vocab))
      setDriveData(adaptDrive(drive))
      setActionData(adaptAction(action))
      setDevStage(dev)
      setSessionData(adaptSession(session))
      setComprehensionData(adaptComprehension(comprehension))
      setPhraseRatioData(adaptPhraseRatio(phrase))
      setExperientialProvenance(adaptExperientialProvenance(phrase))
    } catch (err: unknown) {
      // Only reaches here if Promise.all itself throws, which should not happen
      // since each fetchEndpoint catches its own errors. Belt-and-suspenders.
      setError((err instanceof Error ? err.message : null) || 'Failed to fetch dashboard data')
    } finally {
      setLoading(false)
    }
  }, [])

  const hasData =
    vocabData.length > 0 ||
    driveData.length > 0 ||
    sessionData.length > 0 ||
    actionData.length > 0 ||
    comprehensionData.length > 0

  return {
    loading,
    error,
    vocabData,
    driveData,
    actionData,
    devStage,
    sessionData,
    comprehensionData,
    phraseRatioData,
    experientialProvenance,
    hasData,
    fetchAll,
  }
}
