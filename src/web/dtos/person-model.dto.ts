/**
 * Person model DTOs for other person profile endpoints.
 *
 * CANON §Architecture (Other KG): These DTOs serialize person models
 * retrieved from the Grafeo Other KG. One Other KG exists per person
 * (e.g., Person_Jim).
 */

// ---------------------------------------------------------------------------
// Person Model Summary
// ---------------------------------------------------------------------------

/**
 * PersonModelSummaryResponse — summary of a person model from Other KG.
 *
 * Returned by GET /api/persons/{personId} endpoint.
 * Provides a lightweight view of what Sylphie knows about another person.
 *
 * CANON §Architecture: Other KG is completely isolated from Self KG
 * and the WKG. These fields are specific to person modeling and do not
 * cross subsystem boundaries.
 */
export interface PersonModelSummaryResponse {
  /**
   * Person identifier matching the Grafeo KG(Other) node ID.
   * Example: 'Person_Jim'
   */
  readonly personId: string;

  /** Display name (e.g., 'Jim'). */
  readonly name: string;

  /**
   * Array of inferred personality or preference traits.
   * Built up incrementally from conversation history.
   * Examples: ['technical', 'patient', 'curious', 'formal']
   */
  readonly traits: readonly string[];

  /** Total number of interaction turns recorded with this person. */
  readonly interactionCount: number;

  /**
   * Wall-clock timestamp in milliseconds since epoch of the most recent
   * interaction turn.
   */
  readonly lastInteractionAt: number;
}
