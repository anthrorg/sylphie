/**
 * CoBeing wire format types for WebSocket protocol negotiation.
 *
 * These types describe the snake_case message shapes expected by the co-being
 * React frontend when connecting with `?protocol=cobeing-v1`. They are kept
 * separate from the Sylphie-native DTOs (camelCase, in src/web/dtos/) so that
 * each format can evolve independently without coupling the two frontends.
 *
 * The adapters layer translates between the internal Sylphie representation
 * and these wire types. Nothing outside of src/web/adapters/ should produce
 * or consume these types directly — they are an I/O concern, not a domain
 * concern.
 *
 * CANON note: These types carry no provenance or drive computation logic.
 * They are serialization shapes only. Provenance and confidence values
 * embedded here originate from the WKG and are passed through unchanged;
 * they are never assigned or modified in this layer.
 */

// ---------------------------------------------------------------------------
// Drive Frame
// ---------------------------------------------------------------------------

/**
 * CoBeing_DriveFrame — flat drive snapshot broadcast.
 *
 * Emitted on every Drive Engine executor cycle and forwarded to co-being
 * clients. The `pressure` sub-object uses snake_case names to match the
 * co-being frontend's expected schema.
 *
 * `type` is always the literal string 'executor_cycle'.
 * `timestamp` is wall-clock milliseconds since epoch.
 * `pressure` contains all 12 drive values in [0.0, 1.0].
 * `pressure_metadata` carries sequencing and staleness information.
 * `state`, `category`, `action`, `action_confidence` describe the Decision
 * Making subsystem's current evaluation result (null when unavailable).
 * `transition_count` and `cycle_count` are monotonic counters for ordering.
 */
export interface CoBeing_DriveFrame {
  readonly type: 'executor_cycle';

  /** Wall-clock milliseconds since epoch when this frame was assembled. */
  readonly timestamp: number;

  /**
   * All 12 drive pressure values.
   * Range [0.0, 1.0] per CANON §Drive Engine.
   */
  readonly pressure: {
    readonly system_health: number;
    readonly moral_valence: number;
    readonly integrity: number;
    readonly cognitive_awareness: number;
    readonly guilt: number;
    readonly curiosity: number;
    readonly boredom: number;
    readonly anxiety: number;
    readonly satisfaction: number;
    readonly sadness: number;
    readonly information_integrity: number;
    readonly social: number;
  };

  /**
   * Metadata for sequencing and staleness detection.
   *
   * `sequence_number` is a monotonically increasing integer.
   * `timestamp_ms` is the Drive Engine's internal timestamp in milliseconds.
   * `is_stale` is true when this frame contains recycled data (no new tick
   *  was available before the broadcast deadline).
   */
  readonly pressure_metadata: {
    readonly sequence_number: number;
    readonly timestamp_ms: number;
    readonly is_stale: boolean;
  };

  /**
   * Current Decision Making state label.
   * Examples: 'IDLE', 'TYPE1_EVALUATION', 'TYPE2_DELIBERATION'.
   */
  readonly state: string;

  /**
   * Behavioral category of the currently selected action.
   * Null when no action is active.
   */
  readonly category: string | null;

  /**
   * Identifier of the currently selected action.
   * Null when no action is active.
   */
  readonly action: string | null;

  /**
   * Confidence of the currently selected action (Type 1 confidence or null).
   * Null for Type 2 deliberations or when no action is active.
   */
  readonly action_confidence: number | null;

  /** Total number of state transitions since startup. */
  readonly transition_count: number;

  /** Total number of executor cycles since startup. */
  readonly cycle_count: number;
}

// ---------------------------------------------------------------------------
// Conversation Turn
// ---------------------------------------------------------------------------

/**
 * CoBeing_ConversationTurn — single conversation message in co-being format.
 *
 * Covers both inbound (transcription) and outbound (response, thinking, cb_speech)
 * message types as well as administrative messages (system_status, error, guardian).
 *
 * `is_grounded` and `grounding_ratio` are present on response turns and reflect
 * whether the generated text was anchored to WKG knowledge (CANON Theater Prohibition).
 * `audioBase64` and `audioFormat` are present on cb_speech turns carrying TTS output.
 * `cost_usd` is present on Type 2 deliberation turns (CANON §Type 2 cost reporting).
 */
export interface CoBeing_ConversationTurn {
  /**
   * Message type discriminator.
   *
   * - 'thinking'       : internal deliberation trace (Type 2 intermediate output)
   * - 'response'       : Sylphie's generated response to the guardian
   * - 'transcription'  : STT result from the guardian's voice input
   * - 'error'          : protocol or processing error notification
   * - 'system_status'  : administrative state change (e.g., session start/end)
   * - 'guardian'       : message originating from the guardian (text or feedback)
   * - 'cb_speech'      : TTS audio payload (base64-encoded)
   */
  readonly type: 'thinking' | 'response' | 'transcription' | 'error' | 'system_status' | 'guardian' | 'cb_speech';

  /** Globally unique turn identifier for correlation across subsystems. */
  readonly turn_id: string;

  /** Textual content of this turn. Empty string for audio-only cb_speech turns. */
  readonly text: string;

  /** ISO 8601 timestamp string of when this turn was produced. */
  readonly timestamp: string;

  /**
   * Whether this response is grounded in WKG knowledge.
   * Null for turn types that are not Sylphie-generated responses.
   * CANON Theater Prohibition: responses are evaluated for grounding.
   */
  readonly is_grounded: boolean | null;

  /**
   * Fraction of response content traceable to WKG nodes, in [0.0, 1.0].
   * Null for turn types that are not Sylphie-generated responses.
   */
  readonly grounding_ratio: number | null;

  /**
   * Base64-encoded audio data.
   * Present only when type is 'cb_speech'.
   */
  readonly audioBase64?: string;

  /**
   * MIME type or codec string for the audio payload.
   * Examples: 'audio/mpeg', 'audio/wav', 'opus'.
   * Present only when audioBase64 is present.
   */
  readonly audioFormat?: string;

  /**
   * USD cost of the LLM call that produced this turn.
   * Present only on Type 2 deliberation turns.
   * CANON §Type 2 cost: costs must be reported to support drive pressure.
   */
  readonly cost_usd?: number;
}

// ---------------------------------------------------------------------------
// Graph Types
// ---------------------------------------------------------------------------

/**
 * CoBeing_GraphNode — WKG node in co-being wire format.
 *
 * Maps to the internal GraphNodeDto but uses snake_case field names and
 * carries the schema_level field that the co-being graph visualization
 * requires for rendering hierarchy.
 *
 * CANON §Provenance Is Sacred: `provenance_type` is always present and
 * is never stripped or upgraded by the adapter.
 */
export interface CoBeing_GraphNode {
  /** Unique node identifier (Neo4j element ID). */
  readonly node_id: string;

  /**
   * Node type / primary label.
   * Examples: 'Entity', 'Action', 'Procedure', 'Concept'
   */
  readonly node_type: string;

  /** Display label (the node's primary human-readable name). */
  readonly label: string;

  /**
   * Ontological level of this node within the WKG schema hierarchy.
   *
   * - 'instance'     : a specific real-world entity or event
   * - 'schema'       : a type or class that instances belong to
   * - 'meta_schema'  : a meta-level concept defining schema structure
   */
  readonly schema_level: 'instance' | 'schema' | 'meta_schema';

  /** Domain-specific node properties. */
  readonly properties: Record<string, unknown>;

  /**
   * Provenance source string.
   * Values: 'SENSOR', 'GUARDIAN', 'LLM_GENERATED', 'INFERENCE',
   *         'GUARDIAN_APPROVED_INFERENCE', 'TAUGHT_PROCEDURE',
   *         'BEHAVIORAL_INFERENCE', 'SYSTEM_BOOTSTRAP'
   */
  readonly provenance_type: string;

  /**
   * ACT-R confidence score in [0.0, 1.0].
   * CANON §Confidence Ceiling: never exceeds 0.60 without retrieval-and-use.
   */
  readonly confidence: number;

  /** ISO 8601 timestamp string of when this node was first created. */
  readonly created_at: string;

  /**
   * ISO 8601 timestamp string of the last update.
   * Null if the node has never been updated since creation.
   */
  readonly updated_at: string | null;
}

/**
 * CoBeing_GraphEdge — WKG edge in co-being wire format.
 *
 * Maps to the internal GraphEdgeDto but uses snake_case field names and
 * includes a `label` field for edge display in the co-being visualization.
 */
export interface CoBeing_GraphEdge {
  /** Unique edge identifier (Neo4j relationship element ID). */
  readonly edge_id: string;

  /** Element ID of the source (start) node. */
  readonly source_node_id: string;

  /** Element ID of the target (end) node. */
  readonly target_node_id: string;

  /**
   * Neo4j relationship type (UPPER_SNAKE_CASE by convention).
   * Examples: 'IS_A', 'CAN_PRODUCE', 'LOCATED_IN', 'TAUGHT_BY'
   */
  readonly edge_type: string;

  /** Human-readable display label for this edge (typically the edge_type, formatted). */
  readonly label: string;

  /** Domain-specific edge properties. */
  readonly properties: Record<string, unknown>;

  /**
   * ACT-R confidence score in [0.0, 1.0].
   */
  readonly confidence: number;

  /** ISO 8601 timestamp string of when this edge was first created. */
  readonly created_at: string;
}

/**
 * CoBeing_GraphDelta — incremental or full graph update message.
 *
 * Sent by the graph-updates gateway when WKG changes occur. The `type`
 * discriminator determines which optional fields are populated.
 *
 * - node_added / node_created / node_updated: `node` is present
 * - node_removed: `node` is present (with the removed node's last state)
 * - edge_added / edge_created / edge_updated: `edge` is present
 * - edge_removed: `edge` is present (with the removed edge's last state)
 * - snapshot: `snapshot` is present with a full graph dump
 */
export interface CoBeing_GraphDelta {
  /**
   * Delta type discriminator.
   *
   * node_added and node_created are both valid; they are synonymous aliases
   * that different parts of the Learning module may emit.
   */
  readonly type:
    | 'node_added'
    | 'node_created'
    | 'node_updated'
    | 'node_removed'
    | 'edge_added'
    | 'edge_created'
    | 'edge_updated'
    | 'edge_removed'
    | 'snapshot';

  /**
   * Node involved in this delta.
   * Present for all node_* types.
   */
  readonly node?: CoBeing_GraphNode;

  /**
   * Edge involved in this delta.
   * Present for all edge_* types.
   */
  readonly edge?: CoBeing_GraphEdge;

  /**
   * Full graph snapshot.
   * Present only when type is 'snapshot'.
   */
  readonly snapshot?: {
    readonly nodes: CoBeing_GraphNode[];
    readonly edges: CoBeing_GraphEdge[];
  };
}
