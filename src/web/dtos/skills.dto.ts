/**
 * Skills management DTOs for the guardian skills dashboard.
 *
 * Skills in Sylphie are Procedure nodes in the World Knowledge Graph. This
 * module exposes them for guardian inspection, concept upload, and soft-delete.
 *
 * CANON §Dual-Process Cognition: Procedures start as Type 2 (LLM-assisted)
 * and graduate to Type 1 (graph reflex) when confidence > 0.80 AND MAE < 0.10
 * over the last 10 uses. SkillDto carries the isType1 flag so the dashboard
 * can display the Type 1/Type 2 ratio over time.
 *
 * CANON §Confidence Ceiling (Standard 3): Uploaded concepts are capped at 0.60
 * until a successful retrieval-and-use event. This is enforced on the server;
 * clients cannot override it.
 *
 * CANON §Provenance Is Sacred: All DTOs include provenance. The guardian
 * upload endpoint forces provenance to 'GUARDIAN' and confidence to 0.60
 * regardless of what the client sends.
 */

// ---------------------------------------------------------------------------
// Core skill DTO
// ---------------------------------------------------------------------------

/**
 * SkillDto — serialized Procedure node for the guardian skills dashboard.
 *
 * Maps a WKG Procedure node to a JSON-safe structure. Includes all fields
 * needed by the dashboard to display skill health, Type 1/Type 2 status,
 * and activation state.
 */
export interface SkillDto {
  /** Neo4j element ID (unique string). */
  readonly id: string;

  /**
   * Human-readable display label.
   * Drawn from the node's `name` or `label` property, falling back to
   * the primary Neo4j label if neither is present.
   */
  readonly label: string;

  /**
   * Node type — the primary Neo4j label.
   * For skills this is typically 'Procedure'. Compound labels are joined
   * with '/' (e.g., 'Action/Procedure') for display.
   */
  readonly type: string;

  /**
   * Current ACT-R confidence in [0.0, 1.0].
   * Computed from actrParams at response-build time. Deactivated skills
   * are forced to 0.0.
   */
  readonly confidence: number;

  /**
   * Provenance source for this procedure node.
   * One of: SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE, TAUGHT_PROCEDURE, etc.
   * Guardian-uploaded concepts always carry 'GUARDIAN'.
   */
  readonly provenance: string;

  /**
   * Number of successful retrieval-and-use events recorded against this node.
   * Drives logarithmic confidence growth per the ACT-R formula.
   */
  readonly useCount: number;

  /**
   * Mean absolute error of predictions made using this procedure over the
   * last 10 uses. Null if the procedure has never been used for predictions.
   * Required below 0.10 for Type 1 graduation.
   */
  readonly predictionMae: number | null;

  /**
   * Whether this procedure has graduated to Type 1 (graph reflex).
   *
   * True when: confidence > 0.80 AND predictionMae < 0.10.
   * CANON §Dual-Process Cognition: Both conditions must hold simultaneously.
   */
  readonly isType1: boolean;

  /**
   * ISO 8601 timestamp of when this procedure node was created.
   * Used for time-series tracking of skill acquisition rate.
   */
  readonly createdAt: string;

  /**
   * ISO 8601 timestamp of the most recent successful retrieval-and-use,
   * or null if the procedure has never been retrieved. Derived from
   * actrParams.lastRetrievalAt.
   */
  readonly lastUsedAt: string | null;

  /**
   * Whether this procedure has been soft-deleted.
   * Deactivated skills have confidence 0.0 and a `deactivated: true` Neo4j
   * property. They are excluded from normal retrieval queries but remain
   * in the graph for audit purposes.
   */
  readonly deactivated: boolean;
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/**
 * ConceptUploadRequest — body for POST /api/skills/upload.
 *
 * Guardian-initiated concept injection into the WKG. The server forces
 * provenance to 'GUARDIAN' and confidence to 0.60 regardless of any values
 * the client sends. This prevents the guardian upload pathway from being
 * used to inject artificially high-confidence knowledge.
 *
 * CANON §Immutable Standard 6 (No Self-Modification): This endpoint is
 * guardian-only. Sylphie's subsystems do not call it.
 *
 * CANON §A.13 amendment: Guardian-initiated concept upload is explicitly
 * permitted with GUARDIAN provenance at 0.60 base confidence.
 */
export interface ConceptUploadRequest {
  /**
   * Concept name / display label.
   * Must be non-empty. Used as the `name` property on the WKG node and
   * as the human-readable label in skill listings.
   */
  readonly label: string;

  /**
   * WKG node type (primary Neo4j label).
   * Must be one of the permitted WKG node types (see VALID_WKG_NODE_TYPES).
   * Examples: 'Concept', 'Entity', 'Procedure', 'Action'.
   */
  readonly type: string;

  /**
   * Domain-specific properties to store on the node.
   * All values are stored in the Neo4j `properties` bag. The server adds
   * `created_by: 'guardian_upload'` to this map before persisting.
   */
  readonly properties: Record<string, unknown>;

  /**
   * Optional relationships to establish from this concept to existing nodes.
   * Each entry creates an edge in the WKG with GUARDIAN provenance.
   */
  readonly relationships?: ReadonlyArray<{
    /** Neo4j element ID of the target node. Must already exist in the WKG. */
    readonly targetId: string;

    /**
     * Neo4j relationship type string (UPPER_SNAKE_CASE).
     * Example: 'IS_A', 'RELATED_TO', 'TAUGHT_BY'.
     */
    readonly relationship: string;
  }>;
}

// ---------------------------------------------------------------------------
// Response wrappers
// ---------------------------------------------------------------------------

/**
 * SkillListResponse — response for GET /api/skills.
 *
 * All active and inactive Procedure nodes, ordered by confidence descending.
 */
export interface SkillListResponse {
  /** All Procedure nodes, ordered by confidence descending. */
  readonly skills: readonly SkillDto[];

  /** Total count of Procedure nodes (including deactivated). */
  readonly total: number;

  /** Count of active (non-deactivated) procedures. */
  readonly activeCount: number;

  /** Count of Type 1-graduated procedures. */
  readonly type1Count: number;
}

/**
 * SkillUploadResponse — response for POST /api/skills/upload.
 *
 * The created node plus metadata confirming the enforced values.
 */
export interface SkillUploadResponse {
  /** The created node, serialized as SkillDto. */
  readonly skill: SkillDto;

  /** Confirms that provenance was forced to 'GUARDIAN'. */
  readonly enforcedProvenance: 'GUARDIAN';

  /** Confirms that confidence was forced to 0.60 (CANON §Confidence Ceiling). */
  readonly enforcedConfidence: 0.60;

  /** Count of relationships created (0 if none were requested). */
  readonly relationshipsCreated: number;
}
