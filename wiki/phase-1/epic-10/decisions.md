# Epic 10: Key Design Decisions

**Epic:** 10 — Integration and End-to-End Verification
**Date:** 2026-03-29
**Status:** Planned

---

## Decision 1: Provenance Is Non-Negotiable

**Source:** Unanimous agreement across all 7 agents (Canon, Proof, Ashby, Piaget, Skinner, Luria, Forge).

**Decision:** Every single write to the WKG must carry provenance (SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE). No exceptions. Epic 10 audits this as a precondition.

**Rationale:** Provenance enables the Lesion Test (filter to experiential-only knowledge), attractor detection (hallucinated knowledge ratio), learning proof (experiential provenance ratio), and the Confidence Ceiling (Standard 3). Without provenance, none of these verifications are possible.

---

## Decision 2: Type 1/Type 2 Ratio Is the Central Performance Metric

**Source:** All 7 agents.

**Decision:** Every decision event must record whether it was Type 1 (graph-based) or Type 2 (LLM-assisted). Healthy Phase 1 shows monotonic increase in Type 1 ratio. Plateauing at <30% after month 2 is a RED FLAG (Type 2 Addict attractor).

---

## Decision 3: Attractor State Detection Is Part of Integration Testing

**Source:** Ashby, Luria, Piaget, Proof.

**Decision:** Epic 10 explicitly tests that all 6 known pathological attractors are NOT happening. Each attractor has 3-5 specific detection metrics with warning and critical thresholds.

---

## Decision 4: LLM Lesion Is Phase 1 Completion Requirement

**Source:** Luria, Piaget, Canon.

**Decision:** The LLM Lesion Test is mandatory for Phase 1 completion. WKG and Drive Engine lesions are recommended but can be deferred if timeline is tight.

**Rationale:** LLM Lesion directly proves the central CANON claim: "the LLM is her voice, not her mind." If removing the LLM causes catastrophic failure, Phase 1 has failed.

---

## Decision 5: LLM-Disabled Cost Pressure Pauses

**Source:** Cross-examination synthesis.

**Decision:** During LLM Lesion Test, Type 2 cost pressure pauses (frozen at current value). Not accumulated, not reset.

**Rationale:** Pausing preserves the distinction between "cost prevents use" vs. "system is incapable," avoids artificial relief or punishment, and allows accurate measurement of Type 1 capability.

**Note:** Subject to Jim's approval.

---

## Decision 6: Behavioral Validation Complements Metrics

**Source:** Piaget, Skinner, Luria.

**Decision:** Epic 10 includes conversation log analysis alongside automated metrics. Metrics are necessary but not sufficient — actual behavioral patterns must be observed.

**Note:** Subject to Jim confirming behavioral validation is required for Phase 1.

---

## Decision 7: Two New Modules (Testing + Metrics)

**Source:** Forge.

**Decision:** Epic 10 creates two new NestJS modules:
- `src/testing/` — TestEnvironment, Fixtures, Lesion modes (conditional registration, dev/test only)
- `src/metrics/` — MetricsComputation, DriftDetection, AttractorDetection (available in production for dashboard)

Neither module contains business logic. Testing is infrastructure. Metrics is read-only computation from existing data stores.

---

## Decision 8: Baseline-Then-Drift Model

**Source:** Proof, Ashby.

**Decision:** Sessions 1-10 establish drift detection baselines. Anomaly detection begins at session 20+. This matches the CANON's "every 10 sessions" drift detection protocol.

---

## Decisions Approved by Jim (2026-03-29)

1. **Define "Genuine Learning" acceptance criteria** — APPROVED — Define specific thresholds during E10 implementation based on observed data from E1-E9
2. **Behavioral Personality Validation scope** — APPROVED — Recommended for Phase 1 but not blocking
3. **WKG and Drive Engine Lesion scope** — APPROVED — Recommended but can be deferred if timeline tight
4. **Specific numeric thresholds** — APPROVED — Establish baselines during sessions 1-10 per drift detection protocol
