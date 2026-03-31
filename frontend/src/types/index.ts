// All types defined locally. No @cobeing/shared dependency.

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

export type WSState = 'connected' | 'reconnecting' | 'disconnected'

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export interface GraphNode {
  node_id: string
  node_type: string
  label: string
  schema_level: string
  properties: Record<string, unknown>
  provenance_type: string
  confidence: number
  created_at: string
  updated_at: string | null
}

export interface GraphEdge {
  edge_id: string
  source_node_id: string
  target_node_id: string
  edge_type: string
  label: string
  properties: Record<string, unknown>
  confidence: number
  created_at: string
}

export interface GraphSnapshot {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface GraphDelta {
  type:
    | 'node_added'
    | 'node_created'
    | 'node_updated'
    | 'node_removed'
    | 'node_deleted'
    | 'edge_added'
    | 'edge_created'
    | 'edge_updated'
    | 'edge_removed'
    | 'edge_deleted'
    | 'proposal_created'
    | 'proposal_resolved'
    | 'system_status'
    | 'snapshot'
  data?: Record<string, unknown>
  node?: GraphNode
  edge?: GraphEdge
  snapshot?: GraphSnapshot
}

export interface GraphStats {
  nodes: number
  edges: number
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export interface ConversationMessage {
  type:
    | 'thinking'
    | 'response'
    | 'transcription'
    | 'error'
    | 'system_status'
    | 'ping'
    | 'guardian'
    | 'cb_speech'
  turn_id?: string
  phrase_node_id?: string
  text: string
  content?: string
  grounding_ratio?: number | null
  referenced_node_count?: number | null
  is_grounded?: boolean | null
  intent_type?: string | null
  llm_called?: boolean | null
  timestamp?: string
  cost_usd?: number
  thinking?: string
  reasoning_badge?: string
  source_action?: string
  // Audio fields present when the backend returns TTS audio inline
  audioBase64?: string
  audioFormat?: string
}

// Transcription result awaiting guardian confirmation (confidence < 0.5)
export interface PendingTranscription {
  text: string
  confidence: number
  latencyMs: number
  audioBlob: Blob
}

// ---------------------------------------------------------------------------
// Drive / Pressure
// ---------------------------------------------------------------------------

export interface TelemetryPressure {
  system_health: number
  moral_valence: number
  integrity: number
  cognitive_awareness: number
  guilt: number
  curiosity: number
  boredom: number
  anxiety: number
  satisfaction: number
  sadness: number
  information_integrity: number
  social: number
}

export type DriveAxisName = keyof TelemetryPressure

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export interface TelemetryCycle {
  type: 'executor_cycle'
  timestamp: number
  pressure: TelemetryPressure
  pressure_metadata: {
    sequence_number: number
    timestamp_ms: number
    is_stale: boolean
  }
  drive_velocity: Record<string, number> | null
  drive_entropy: number
  dominant_drive: string | null
  category: string | null
  action: string | null
  action_confidence: number | null
  state: string
  transition_count: number
  cycle_count: number
  guardian_present: boolean | null
  speech_refractory: number
  action_diversity: Record<string, number>
  system_health: Record<string, unknown>
  schema_version: number
  dynamic_threshold: number
}

export interface TelemetryStateTransition {
  type: 'state_transition'
  timestamp: number
  from_state: string
  to_state: string
  event: string
  count: number
}

export interface TelemetryPrediction {
  type: 'prediction_result'
  timestamp: number
  action: string
  predicted_effects: Record<string, number>
  actual_effects: Record<string, number>
  accuracy: number
  used_observed: boolean
}

export interface TelemetryMaintenanceCycle {
  type: 'maintenance_cycle'
  timestamp: number
  jobs_run: number
  committed: number
  phrase_consolidation: boolean
}

export type TelemetryMessage =
  | TelemetryCycle
  | TelemetryStateTransition
  | TelemetryPrediction
  | TelemetryMaintenanceCycle

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * SkillDto mirrors the backend skills.dto.ts SkillDto shape.
 * Represents a WKG Procedure node returned by GET /api/skills.
 */
export interface SkillDto {
  id: string
  label: string
  type: string
  confidence: number
  provenance: string
  useCount: number
  predictionMae: number | null
  isType1: boolean
  createdAt: string
  lastUsedAt: string | null
  deactivated: boolean
}

/**
 * Response from POST /api/skills/upload.
 */
export interface SkillUploadResponse {
  skill: SkillDto
  enforcedProvenance: 'GUARDIAN'
  enforcedConfidence: number
  relationshipsCreated: number
}

/**
 * Legacy package shape — retained for reset API compatibility.
 */
export interface SkillPackage {
  package_id: string
  version: string
  display_name?: string
  description?: string
  nodes_count: number
  author?: string
}

export interface SkillInstallResponse {
  success: boolean
  message?: string
  package_id?: string
  version?: string
  nodes_created?: number
  edges_created?: number
  already_installed?: boolean
}

export interface SkillResetResponse {
  success: boolean
  message?: string
  operation?: string
  nodes_deleted?: number
  edges_deleted?: number
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SessionStats {
  session_cost_usd: number
  total_nodes: number
  graph_changes: number
  conversation_turns: number
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

export interface VoiceState {
  available: boolean
  recording: boolean
  processing: boolean
  // Whether audio playback is muted; persisted to localStorage
  muted: boolean
  // Set when microphone permission is denied
  permissionDenied: boolean
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export interface CameraState {
  active: boolean
  mode: 'pip' | 'main'
  /** How the camera feed is currently being delivered to the UI. */
  feedMode: 'webrtc' | 'local' | 'mjpeg' | 'unavailable'
}

// ---------------------------------------------------------------------------
// Graph filters
// ---------------------------------------------------------------------------

export type SchemaLevel = 'all' | 'instance' | 'schema' | 'meta_schema'
export type ProvenanceFilter =
  | 'all'
  | 'SENSOR'
  | 'GUARDIAN'
  | 'LLM_GENERATED'
  | 'INFERENCE'
  | 'SYSTEM_BOOTSTRAP'
export type NodeTypeFilter = 'WordFormNode' | 'WordNode' | 'ActionProcedure'

export interface GraphFilters {
  schemaLevel: SchemaLevel
  provenance: ProvenanceFilter
  nodeTypes: Set<NodeTypeFilter>
  search: string
}

// ---------------------------------------------------------------------------
// WebRTC
// ---------------------------------------------------------------------------

export type WebRTCConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed'

export interface WebRTCState {
  connectionState: WebRTCConnectionState
  signalingState: WSState
  audioEnabled: boolean
  videoEnabled: boolean
  hasLocalStream: boolean
  hasRemoteStream: boolean
}

export interface SignalingOffer {
  type: 'offer'
  sdp: string
}

export interface SignalingAnswer {
  type: 'answer'
  sdp: string
}

export interface SignalingCandidate {
  type: 'candidate'
  candidate: RTCIceCandidateInit
}

export interface SignalingError {
  type: 'error'
  message: string
}

export interface SignalingReady {
  type: 'ready'
}

export type SignalingMessage =
  | SignalingOffer
  | SignalingAnswer
  | SignalingCandidate
  | SignalingError
  | SignalingReady
