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
 * - CANDIDATE: A conversation-derived proper noun staged in the WORLD graph as a
 *   `:Candidate` node (NOT a live `:Entity`). It is visible to reasoning as
 *   low-confidence context but is NEVER grounding-eligible until a guardian
 *   promotes it (`:Candidate → :Entity`). This is the CANON Std-3 three-graph
 *   isolation fix for the §2.8 person-fact leak (Wave 3 / chunk C0). See the
 *   `:Candidate` contract block below.
 */
export type ExtendedProvenanceSource =
  | 'GUARDIAN_APPROVED_INFERENCE'
  | 'TAUGHT_PROCEDURE'
  | 'BEHAVIORAL_INFERENCE'
  | 'SYSTEM_BOOTSTRAP'
  | 'CANDIDATE';

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
    case 'CANDIDATE':
      // A staged candidate is the weakest, least-trusted provenance: a raw
      // conversation-derived proper noun with no observation, no teaching, and
      // no successful retrieval behind it. It sits at the INFERENCE floor and is
      // additionally hard-capped at CANDIDATE_CONFIDENCE_CAP (≤0.60, CANON Std-3
      // ceiling) by the minting path (C3). It must NEVER ground a label.
      return Math.min(CANDIDATE_CONFIDENCE_CAP, PROVENANCE_BASE_CONFIDENCE.INFERENCE);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The `:Candidate` contract (Wave 3 / chunk C0 — CANON Std-3 isolation fix §2.8)
// ───────────────────────────────────────────────────────────────────────────
//
// `:Candidate` is a Neo4j node label that lives in the **WORLD** Neo4j instance
// ALONGSIDE `:Entity` (same graph, NOT a separate store — graph isolation is
// preserved because the SELF/OTHER instances are untouched). It is the staging
// form for conversation-derived proper nouns.
//
// INVARIANTS (all three are load-bearing; violating any reopens §2.8):
//
//   1. PROVENANCE.  Every `:Candidate` carries `provenance_type: 'CANDIDATE'`
//      (the value `CANDIDATE_PROVENANCE_TYPE` below). This is honest provenance
//      (CANON Std-2): the node was inferred from conversation, not observed,
//      taught, or guardian-confirmed.
//
//   2. CONFIDENCE CAP.  A `:Candidate` confidence is hard-capped at
//      `CANDIDATE_CONFIDENCE_CAP` (0.60 — exactly the CANON Std-3 ceiling). It
//      can never be lifted above this while it remains a candidate; only a
//      guardian promotion (`:Candidate → :Entity`, chunk C4) changes that.
//
//   3. GROUNDING EXCLUSION.  A `:Candidate` is visible to reasoning as
//      low-confidence CONTEXT but is NEVER eligible to produce a GROUNDED
//      grounding label. Every WKG grounding read-path MUST exclude `:Candidate`
//      (see WkgContextService.matchEntities / getSubgraph / getEntityFacts /
//      getRelationships — each carries an explicit `NOT <var>:Candidate` clause).
//
//   4. PERSON SCOPING.  A `:Candidate` minted from conversation carries
//      `grounding_person_id` = the speaker who introduced it (the key under
//      which C3 mints it). This keeps the candidate attributable to its source
//      person and is what a later guardian promotion / OKG cross-check reads.
//
// MINTING (C3) and PROMOTION (C4) are NOT implemented here — C0 is defensive
// groundwork ONLY: the contract + the exclusion of candidates from every
// grounding read-path, so that once C3 starts minting them they are already
// non-groundable by construction.

/**
 * The `provenance_type` string stamped on every `:Candidate` node (CANON Std-2).
 * A conversation-derived proper noun is an inference, never an observation.
 */
export const CANDIDATE_PROVENANCE_TYPE = 'CANDIDATE' as const;

/**
 * The Neo4j node label for staged conversation-derived proper nouns. Lives in
 * the WORLD instance beside `:Entity`; excluded from all grounding read-paths.
 */
export const CANDIDATE_NODE_LABEL = 'Candidate' as const;

/**
 * Hard confidence ceiling for a `:Candidate` node — exactly the CANON Std-3
 * ceiling (0.60). A candidate must never exceed this while unpromoted. The
 * minting path (C3) clamps to this; the contract documents it here so every
 * consumer reads one number.
 */
export const CANDIDATE_CONFIDENCE_CAP = 0.6 as const;

/**
 * The candidate property carrying the speaker/person id that introduced the
 * proper noun (its grounding scope). Set by the minting path (C3); read by the
 * guardian promotion path (C4).
 */
export const CANDIDATE_PERSON_ID_PROP = 'grounding_person_id' as const;

/**
 * The `provenance_type` stamped on a `:Candidate` node after a guardian promotes
 * it to a live `:Entity` (Wave 3 / chunk C4). A guardian confirmation that "this
 * proper noun is a real entity" elevates an inference to near-GUARDIAN trust, so
 * the promoted node carries GUARDIAN_APPROVED_INFERENCE (CANON Std-2: the node was
 * inferred from conversation, then guardian-approved — never claimed as SENSOR).
 */
export const CANDIDATE_PROMOTION_PROVENANCE_TYPE = 'GUARDIAN_APPROVED_INFERENCE' as const;

/**
 * The confidence a guardian promotion lifts a candidate to (Wave 3 / chunk C4).
 *
 * This is the SAME legitimate guardian exception to the 0.60 ceiling used by
 * `deriveOkgFactTier` case (a) for a guardian's own self-report: 0.90. CANON
 * Std-5 (guardian asymmetry) is what authorizes lifting above the Std-3 ceiling —
 * and ONLY a verified guardian may trigger the promotion, so the cap-lift is
 * reachable exclusively through guardian confirmation. A non-guardian can never
 * lift a candidate above CANDIDATE_CONFIDENCE_CAP (0.60).
 */
export const GUARDIAN_CONFIRMED_CONFIDENCE = 0.9 as const;

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
