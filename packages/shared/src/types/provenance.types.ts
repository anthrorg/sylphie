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

// ───────────────────────────────────────────────────────────────────────────
// WS4 Ticket 5 (§1) — OKG self-fact tiering (guardian-aware, identity-blind)
// ───────────────────────────────────────────────────────────────────────────

/** The `source` field carried by an extracted OKG fact. */
export type OkgFactSource = 'self_reported' | 'observed' | 'inferred';

/**
 * The confidence/provenance tier a single OKG Attribute write should carry.
 * `provenanceType` is the free-form provenance_type string stamped on the
 * Attribute node (no DB enum — see the WS4-T5 graph contract §0.5).
 */
export interface OkgFactTier {
  readonly confidence: number;
  readonly provenanceType: 'GUARDIAN' | 'SELF_REPORTED' | 'OBSERVED' | 'INFERENCE';
}

/**
 * Derive the OKG self-fact write tier from `(source, isGuardian)` — NEVER from
 * an identity string. This is the CANON fix for Standards 3 and 5 (WS4-T5 §1):
 *
 *   (a) self_reported && isGuardian  → 0.90 / GUARDIAN
 *       A guardian's self-knowledge is guardian-confirmed by definition; 0.90
 *       is the legitimate guardian exception to the 0.60 ceiling (Std 5).
 *   (b) self_reported && !isGuardian → 0.60 / SELF_REPORTED
 *       0.60 is exactly the Standard-3 ceiling: an unconfirmed self-report is
 *       the strongest non-guardian evidence; lower would suppress legitimate
 *       guest recall. SELF_REPORTED is a new OKG-scoped label — GUARDIAN would
 *       re-introduce the Std-5 violation; INFERENCE would lie about provenance.
 *   (c) observed                     → 0.60 / OBSERVED
 *   (d) inferred (or any other)      → 0.60 / INFERENCE
 *
 * Guardian status NEVER lifts (c)/(d) above the 0.60 ceiling — the 0.90
 * exception is reserved for a guardian's own self-report (a), the only case
 * where guardian-confirmation is intrinsic to the evidence.
 *
 * Pure and deterministic: this is the unit-tested core (WS4-T5 §6 A2/A3).
 */
export function deriveOkgFactTier(source: OkgFactSource | string, isGuardian: boolean): OkgFactTier {
  const isSelfReported = source === 'self_reported';
  if (isSelfReported) {
    return isGuardian
      ? { confidence: 0.9, provenanceType: 'GUARDIAN' }
      : { confidence: 0.6, provenanceType: 'SELF_REPORTED' };
  }
  if (source === 'observed') {
    return { confidence: 0.6, provenanceType: 'OBSERVED' };
  }
  return { confidence: 0.6, provenanceType: 'INFERENCE' };
}
