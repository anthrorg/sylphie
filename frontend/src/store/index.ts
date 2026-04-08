import { create } from 'zustand'
import {
  WSState,
  GraphSnapshot,
  GraphStats,
  ConversationMessage,
  SkillPackage,
  SkillDto,
  SessionStats,
  VoiceState,
  CameraState,
  RecognizedItem,
  GraphFilters,
  TelemetryPressure,
  TelemetryCycle,
  WebRTCState,
} from '../types'

interface ActionHistoryEntry {
  action: string
  confidence: number
  timestamp: number
}

interface PredictionHistoryEntry {
  action: string
  accuracy: number
  timestamp: number
}

export interface InnerMonologueEntry {
  /** Verbatim raw text from the telemetry event payload — no LLM summarisation. */
  text: string
  timestamp: string
  episode_id?: string
  /** Raw JSON payload of the originating telemetry event, for verbatim display. */
  rawPayload?: string
}

export interface SystemLogEntry {
  text: string
  timestamp: string
  level: 'info' | 'warn' | 'error'
}

interface AuthUser {
  id: string
  username: string
  isGuardian?: boolean
}

interface AppState {
  // Auth
  authToken: string | null
  authUser: AuthUser | null
  authChecked: boolean
  setAuth: (token: string, user: AuthUser) => void
  clearAuth: () => void
  setAuthChecked: (checked: boolean) => void

  // WebSocket states
  wsState: {
    graph: WSState
    conversation: WSState
    telemetry: WSState
  }

  // Graph data
  graphData: GraphSnapshot
  graphStats: GraphStats

  // OKG / SKG graph data (Other & Self Knowledge Graphs)
  okgData: GraphSnapshot
  okgStats: GraphStats
  skgData: GraphSnapshot
  skgStats: GraphStats

  // PKG graph data (Package/Codebase Knowledge Graph)
  pkgData: GraphSnapshot
  pkgStats: GraphStats

  // Conversation
  messages: ConversationMessage[]
  isThinking: boolean

  // Session info
  sessionStats: SessionStats
  sessionStart: number
  // Tracks consecutive conversation turns without graph changes (stasis detection)
  stasisTurnCount: number
  stasisIndicatorVisible: boolean

  // Skills — WKG Procedure nodes (and other uploaded concepts) from GET /api/skills
  skills: SkillDto[]
  // Legacy package list retained for code paths that still reference it
  skillPackages: SkillPackage[]
  skillPanelOpen: boolean

  // Voice
  voiceState: VoiceState

  // Camera
  cameraState: CameraState
  recognizedItems: RecognizedItem[]

  // WebRTC
  webrtcState: WebRTCState

  // UI state
  sessionInfoExpanded: boolean
  nodeInspectorOpen: boolean
  selectedNodeId: string | null
  graphFilters: GraphFilters

  // Telemetry state
  pressure: TelemetryPressure
  executorState: string
  currentCategory: string | null
  currentAction: string | null
  actionConfidence: number | null
  transitionCount: number
  dynamicThreshold: number
  actionHistory: ActionHistoryEntry[]
  predictionHistory: PredictionHistoryEntry[]
  innerMonologue: InnerMonologueEntry[]
  systemLogs: SystemLogEntry[]
  pressureSequenceNumber: number
  pressureTimestampMs: number
  pressureIsStale: boolean

  // Actions
  setWsState: (channel: 'graph' | 'conversation' | 'telemetry', state: WSState) => void
  setGraphData: (data: GraphSnapshot) => void
  setGraphStats: (stats: GraphStats) => void
  setOkgData: (data: GraphSnapshot) => void
  setOkgStats: (stats: GraphStats) => void
  setSkgData: (data: GraphSnapshot) => void
  setSkgStats: (stats: GraphStats) => void
  setPkgData: (data: GraphSnapshot) => void
  setPkgStats: (stats: GraphStats) => void
  addMessage: (message: ConversationMessage) => void
  setThinking: (thinking: boolean) => void
  setSessionStats: (stats: Partial<SessionStats>) => void
  incrementTurns: () => void
  resetStasisCount: () => void
  setSkills: (skills: SkillDto[]) => void
  setSkillPackages: (packages: SkillPackage[]) => void
  toggleSkillPanel: () => void
  setVoiceState: (state: Partial<VoiceState>) => void
  toggleMute: () => void
  setCameraState: (state: Partial<CameraState>) => void
  setRecognizedItems: (items: RecognizedItem[]) => void
  setWebRTCState: (state: Partial<WebRTCState>) => void
  toggleSessionInfo: () => void
  setNodeInspector: (open: boolean, nodeId?: string | null) => void
  setGraphFilters: (filters: Partial<GraphFilters>) => void
  updateTelemetry: (data: TelemetryCycle) => void
  addActionToHistory: (action: string, confidence: number) => void
  addPredictionToHistory: (action: string, accuracy: number) => void
  addInnerMonologue: (entry: InnerMonologueEntry) => void
  addSystemLog: (entry: SystemLogEntry) => void
}

// Default pressure state: all drives at zero (fully relaxed). Spread into updates to ensure all keys exist.
const ZERO_PRESSURE: TelemetryPressure = {
  system_health: 0,
  moral_valence: 0,
  integrity: 0,
  cognitive_awareness: 0,
  guilt: 0,
  curiosity: 0,
  boredom: 0,
  anxiety: 0,
  satisfaction: 0,
  sadness: 0,
  focus: 0,
  social: 0,
}

// Cap for action history, prediction history, and inner monologue arrays
const MAX_HISTORY = 50

export const useAppStore = create<AppState>((set, get) => ({
  // Auth
  authToken: localStorage.getItem('sylphie_token'),
  authUser: null,
  authChecked: false,
  setAuth: (token, user) => {
    localStorage.setItem('sylphie_token', token)
    set({ authToken: token, authUser: user, authChecked: true })
  },
  clearAuth: () => {
    localStorage.removeItem('sylphie_token')
    set({ authToken: null, authUser: null, authChecked: true })
  },
  setAuthChecked: (checked) => set({ authChecked: checked }),

  // Initial state
  wsState: {
    graph: 'disconnected',
    conversation: 'disconnected',
    telemetry: 'disconnected',
  },

  graphData: { nodes: [], edges: [] },
  graphStats: { nodes: 0, edges: 0 },

  okgData: { nodes: [], edges: [] },
  okgStats: { nodes: 0, edges: 0 },
  skgData: { nodes: [], edges: [] },
  skgStats: { nodes: 0, edges: 0 },
  pkgData: { nodes: [], edges: [] },
  pkgStats: { nodes: 0, edges: 0 },

  messages: [],
  isThinking: false,

  sessionStats: {
    session_cost_usd: 0,
    total_nodes: 0,
    graph_changes: 0,
    conversation_turns: 0,
  },
  sessionStart: Date.now(),
  stasisTurnCount: 0,
  stasisIndicatorVisible: false,

  skills: [],
  skillPackages: [],
  skillPanelOpen: false,

  voiceState: {
    available: false,
    recording: false,
    processing: false,
    // Read persisted mute preference; default to unmuted
    muted: localStorage.getItem('sylphie_voice_muted') === 'true',
    permissionDenied: false,
  },

  cameraState: {
    active: false,
    mode: 'main',
    feedMode: 'unavailable',
  },

  recognizedItems: [],

  webrtcState: {
    connectionState: 'new',
    signalingState: 'disconnected',
    audioEnabled: true,
    videoEnabled: true,
    hasLocalStream: false,
    hasRemoteStream: false,
  },

  sessionInfoExpanded: false,
  nodeInspectorOpen: false,
  selectedNodeId: null,
  graphFilters: {
    schemaLevel: 'all',
    provenance: 'all',
    nodeTypes: new Set(), // Set of node types to DIM (not hide); empty = show all
    search: '',
  },

  // Telemetry initial state
  pressure: { ...ZERO_PRESSURE },
  executorState: 'idle',
  currentCategory: null,
  currentAction: null,
  actionConfidence: null,
  transitionCount: 0,
  dynamicThreshold: 0,
  actionHistory: [],
  predictionHistory: [],
  innerMonologue: [],
  systemLogs: [],
  pressureSequenceNumber: 0,
  pressureTimestampMs: 0,
  pressureIsStale: false,

  // Actions
  setWsState: (channel, state) =>
    set((prev) => ({
      wsState: { ...prev.wsState, [channel]: state },
    })),

  setGraphData: (data) => set({ graphData: data }),

  setGraphStats: (stats) => set({ graphStats: stats }),

  setOkgData: (data) => set({ okgData: data }),
  setOkgStats: (stats) => set({ okgStats: stats }),
  setSkgData: (data) => set({ skgData: data }),
  setSkgStats: (stats) => set({ skgStats: stats }),
  setPkgData: (data) => set({ pkgData: data }),
  setPkgStats: (stats) => set({ pkgStats: stats }),

  addMessage: (message) =>
    set((prev) => ({
      messages: [...prev.messages, message],
    })),

  setThinking: (thinking) => set({ isThinking: thinking }),

  setSessionStats: (stats) =>
    set((prev) => ({
      sessionStats: { ...prev.sessionStats, ...stats },
    })),

  // Increment turn count and check for stasis (10+ turns with no graph changes)
  incrementTurns: () => {
    const state = get()
    const newTurns = state.sessionStats.conversation_turns + 1
    const newStasisCount = state.stasisTurnCount + 1

    set({
      sessionStats: { ...state.sessionStats, conversation_turns: newTurns },
      stasisTurnCount: newStasisCount,
      stasisIndicatorVisible: newStasisCount >= 10,
    })
  },

  // Called when a graph delta arrives, resetting the stasis counter
  resetStasisCount: () => set({ stasisTurnCount: 0, stasisIndicatorVisible: false }),

  setSkills: (skills) => set({ skills }),

  setSkillPackages: (packages) => set({ skillPackages: packages }),

  toggleSkillPanel: () => set((prev) => ({ skillPanelOpen: !prev.skillPanelOpen })),

  setVoiceState: (state) =>
    set((prev) => ({
      voiceState: { ...prev.voiceState, ...state },
    })),

  toggleMute: () =>
    set((prev) => {
      const nextMuted = !prev.voiceState.muted
      localStorage.setItem('sylphie_voice_muted', String(nextMuted))
      return { voiceState: { ...prev.voiceState, muted: nextMuted } }
    }),

  setCameraState: (state) =>
    set((prev) => ({
      cameraState: { ...prev.cameraState, ...state },
    })),

  setRecognizedItems: (items) => set({ recognizedItems: items }),

  setWebRTCState: (state) =>
    set((prev) => ({
      webrtcState: { ...prev.webrtcState, ...state },
    })),

  toggleSessionInfo: () => set((prev) => ({ sessionInfoExpanded: !prev.sessionInfoExpanded })),

  setNodeInspector: (open, nodeId = null) =>
    set({
      nodeInspectorOpen: open,
      selectedNodeId: nodeId,
    }),

  setGraphFilters: (filters) =>
    set((prev) => ({
      graphFilters: { ...prev.graphFilters, ...filters },
    })),

  // Called on every executor_cycle telemetry message from the backend WS
  updateTelemetry: (data) => {
    const state = get()
    const updates: Partial<AppState> = {
      // Spread ZERO_PRESSURE first to guarantee all 12 drive keys exist
      pressure: { ...ZERO_PRESSURE, ...data.pressure },
      executorState: data.state,
      currentCategory: data.category,
      currentAction: data.action,
      actionConfidence: data.action_confidence,
      transitionCount: data.transition_count,
      dynamicThreshold: data.dynamic_threshold ?? 0,
      pressureSequenceNumber: data.pressure_metadata?.sequence_number ?? 0,
      pressureTimestampMs: data.pressure_metadata?.timestamp_ms ?? 0,
      pressureIsStale: data.pressure_metadata?.is_stale ?? false,
    }

    // Side-effect: when the executor selects a new action, auto-append to action history
    // and synthesize an inner monologue entry describing the decision
    if (data.action && data.action_confidence !== null) {
      const newAction: ActionHistoryEntry = {
        action: data.action,
        confidence: data.action_confidence,
        timestamp: data.timestamp,
      }
      const history = [newAction, ...state.actionHistory].slice(0, MAX_HISTORY)
      updates.actionHistory = history

      // Verbatim inner monologue entry from executor_cycle event — no LLM summarisation.
      // Text is a direct template from the event fields, not an LLM interpretation.
      const conf = (data.action_confidence ?? 0).toFixed(3)
      const monologueText = data.category
        ? `executor_cycle: category=${data.category} action=${data.action} confidence=${conf} state=${data.state}`
        : `executor_cycle: action=${data.action} confidence=${conf} state=${data.state}`
      const newEntry: InnerMonologueEntry = {
        text: monologueText,
        // CoBeing_DriveFrame.timestamp is wall-clock milliseconds (Date.now()).
        // Passing it directly to new Date() is correct — no conversion needed.
        timestamp: new Date(data.timestamp).toISOString(),
        rawPayload: JSON.stringify(data),
      }
      updates.innerMonologue = [...state.innerMonologue, newEntry].slice(-MAX_HISTORY)
    }

    set(updates as AppState)
  },

  // Manual action history append (used when not coming from updateTelemetry)
  addActionToHistory: (action, confidence) =>
    set((prev) => ({
      actionHistory: [
        { action, confidence, timestamp: Date.now() / 1000 },
        ...prev.actionHistory,
      ].slice(0, MAX_HISTORY),
    })),

  addPredictionToHistory: (action, accuracy) =>
    set((prev) => ({
      predictionHistory: [
        { action, accuracy, timestamp: Date.now() / 1000 },
        ...prev.predictionHistory,
      ].slice(0, MAX_HISTORY),
    })),

  addInnerMonologue: (entry) =>
    set((prev) => ({
      innerMonologue: [...prev.innerMonologue, entry].slice(-MAX_HISTORY),
    })),

  addSystemLog: (entry) =>
    set((prev) => ({
      systemLogs: [...prev.systemLogs, entry].slice(-200),
    })),
}))
