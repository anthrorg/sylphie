/**
 * Provenance types for all WKG nodes and edges.
 *
 * CANON §7 (Provenance Is Sacred): Every node and edge in the WKG carries a
 * provenance tag. This distinction is never erased — it enables the Lesion
 * Test. Stripping or upgrading provenance in the persistence path is a
 * data-integrity violation.
 *
 * No cross-module imports. This file is a zero-dependency foundation.
 */

/**
 * The four canonical provenance sources defined in CANON §7.
 *
 * - SENSOR: Observed directly by perception systems.
 * - GUARDIAN: Taught or confirmed by Jim.
 * - LLM_GENERATED: Created or refined by the LLM during learning/conversation.
 * - INFERENCE: Derived by the system from existing knowledge.
 */
export type CoreProvenanceSource =
  | 'SENSOR'
  | 'GUARDIAN'
  | 'LLM_GENERATED'
  | 'INFERENCE';

/**
 * Extended provenance sources for specific lifecycle contexts.
 *
 * - GUARDIAN_APPROVED_INFERENCE: An INFERENCE that a guardian has explicitly
 *   confirmed, elevating it to near-GUARDIAN trust.
 * - TAUGHT_PROCEDURE: A procedure node created via guardian teaching, distinct
 *   from one that emerged through Planning.
 * - BEHAVIORAL_INFERENCE: Inferred from observed behavioral patterns rather
 *   than explicit reasoning — e.g., "she always does X before Y".
 * - SYSTEM_BOOTSTRAP: Seed knowledge injected at cold start. Should be minimal
 *   and progressively superseded by experiential provenance.
 */
export type ExtendedProvenanceSource =
  | 'GUARDIAN_APPROVED_INFERENCE'
  | 'TAUGHT_PROCEDURE'
  | 'BEHAVIORAL_INFERENCE'
  | 'SYSTEM_BOOTSTRAP';

/**
 * Union of all valid provenance sources. Use this type at persistence
 * boundaries where extended sources may appear.
 */
export type ProvenanceSource = CoreProvenanceSource | ExtendedProvenanceSource;

/**
 * Initial confidence assigned at node/edge creation, keyed by core provenance.
 *
 * CANON §Confidence Dynamics:
 *   SENSOR:        0.40
 *   GUARDIAN:      0.60
 *   LLM_GENERATED: 0.35  (lower — earned trust, not given)
 *   INFERENCE:     0.30
 *
 * Extended provenance sources inherit from their closest core equivalent.
 * GUARDIAN_APPROVED_INFERENCE → 0.60 (treat as GUARDIAN post-approval)
 * TAUGHT_PROCEDURE → 0.60 (guardian-origin)
 * BEHAVIORAL_INFERENCE → 0.30 (treat as INFERENCE)
 * SYSTEM_BOOTSTRAP → 0.40 (treat as SENSOR)
 */
export const PROVENANCE_BASE_CONFIDENCE: Readonly<Record<CoreProvenanceSource, number>> = {
  SENSOR: 0.40,
  GUARDIAN: 0.60,
  LLM_GENERATED: 0.35,
  INFERENCE: 0.30,
} as const;

/**
 * Resolve the effective base confidence for any provenance source, including
 * extended sources that map to a core equivalent.
 *
 * @param provenance - Any ProvenanceSource value
 * @returns Initial confidence in [0.0, 1.0] per CANON §Confidence Dynamics
 */
export function resolveBaseConfidence(provenance: ProvenanceSource): number {
  switch (provenance) {
    case 'SENSOR':
      return PROVENANCE_BASE_CONFIDENCE.SENSOR;
    case 'GUARDIAN':
    case 'GUARDIAN_APPROVED_INFERENCE':
    case 'TAUGHT_PROCEDURE':
      return PROVENANCE_BASE_CONFIDENCE.GUARDIAN;
    case 'LLM_GENERATED':
      return PROVENANCE_BASE_CONFIDENCE.LLM_GENERATED;
    case 'INFERENCE':
    case 'BEHAVIORAL_INFERENCE':
      return PROVENANCE_BASE_CONFIDENCE.INFERENCE;
    case 'SYSTEM_BOOTSTRAP':
      return PROVENANCE_BASE_CONFIDENCE.SENSOR;
  }
}
