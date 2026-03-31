# Epic 11 — CANON Compliance Report

**Epic:** 11 — Frontend Port & Media Integration
**Reviewed:** 2026-03-30
**Reviewer:** Canon (Project Integrity Guardian)
**Project Phase:** Phase 1 — The Complete System

---

## Overall Verdict: COMPLIANT WITH CONCERNS

Epic 11 is largely sound. The existing backend API layer (DrivesController, TelemetryGateway) already enforces read-only access to drive state at the server level, and the drive isolation architecture from Epics 1-10 is structurally intact. No hard CANON violations were found. Every concern below is a risk that becomes a violation depending on implementation choices.

One item -- webcam/video -- requires Jim's explicit CANON ruling before its ticket can be written.

---

## 1. Theater Prohibition (Immutable Standard 1)

**Verdict: CONCERN -- Guardrail required**

Two frontend-specific risks:

**Risk 1A -- Prettified or smoothed drive display.** If the frontend applies visual smoothing, rounding, or floor-clipping to drive values before display, the guardian loses accurate interoceptive feedback.

**Risk 1B -- Inner monologue panel creating false appearance of coherence.** Display must be verbatim from the event record.

**Required guardrails:**
- Drive visualization must display raw float values with no smoothing, rounding, or suppression
- The [-10.0, 1.0] drive range must be fully represented. Negative values (extended relief) must be visually distinguishable from zero
- Inner monologue panel must render verbatim event payloads from TimescaleDB
- Provenance markers must be visible in graph visualization

---

## 2. No Self-Modification of Evaluation (Immutable Standard 6)

**Verdict: CONCERN -- Requires explicit scope definition before ticket is written**

The Skills Manager is the highest-risk item. CANON A.13 explicitly deferred skill packages.

**Compliant scope:** Display of existing Plan Procedures, guardian review/approval of pending procedures, marking procedures inactive, read-only inspection.

**Non-compliant scope:** Importing external skill packages that bypass Planning pipeline, any skill that modifies drive relief computation or confidence calculation, skills that install drive rules directly.

**Required action -- Jim must define Skills Manager scope.**

---

## 3. Drive Isolation

**Verdict: PASS**

DrivesController exposes only GET endpoints. TelemetryGateway is read-only. Frontend adds no new risk.

---

## 4. LLM Is Voice, Not Mind -- FE Agent Panel

**Verdict: CONCERN -- Architectural distinction must be explicit**

**Required guardrails:**
- FE Agent must be clearly labeled as a separate analytical tool, not Sylphie's voice
- Zero write access to any database
- No shared context between FE Agent Claude calls and Communication subsystem Claude calls

---

## 5. Phase Boundaries -- Webcam/Video

**Verdict: REQUIRES JIM'S RULING**

The CANON lists "Video" as an explicit input to Decision Making, which supports webcam as Phase 1. But Phase 1 says "No physical body yet." A webcam is not a body, but this is Jim's call.

**Required action -- Jim must answer:**
1. Is webcam video in scope for Phase 1?
2. If yes, minimum viable scope: (a) display-only in dashboard, or (b) active input to Decision Making?

---

## 6. Provenance in Graph Visualization

**Verdict: CONCERN -- Guardrail required**

**Required guardrails:**
- Every node/edge must carry a visual provenance indicator for all four types
- Visualization must support filtering by provenance type
- Confidence values must be displayed on nodes/edges
- Observatory must surface Experiential Provenance Ratio as first-class metric

---

## 7. Observatory Dashboard

**Verdict: PASS -- Directly aligned with CANON health metrics**

---

## 8. WebRTC Support

**Verdict: CONCERN -- Scope clarification required**

WebRTC is not in the CANON tech stack. Use case must be specified before implementation.

---

## Checklist Results

| Check | Status | Notes |
|-------|--------|-------|
| Standard 1: Theater Prohibition | CONCERN | Full [-10.0, 1.0] range; no smoothing; verbatim monologue |
| Standard 2: Contingency Requirement | PASS | Frontend does not affect reinforcement |
| Standard 3: Confidence Ceiling | PASS | Frontend does not write knowledge |
| Standard 4: Shrug Imperative | PASS | Frontend does not affect action selection |
| Standard 5: Guardian Asymmetry | PASS | Frontend does not affect feedback weighting |
| Standard 6: No Self-Modification | CONCERN | Skills Manager scope must be defined |
| Drive Isolation | PASS | Verified: DrivesController and TelemetryGateway are read-only |
| Phase Boundary | CONCERN | Webcam requires Jim's ruling; WebRTC needs scope |

---

## Required Actions Before Epic 11 Code

1. **Jim must rule on webcam/video scope** -- Phase 1 input or Phase 2?
2. **Jim must define Skills Manager scope** -- Procedure review UI (compliant) or external import (needs CANON amendment)?
3. **WebRTC use case must be specified**

## Proposed CANON Amendments

**Amendment 1:** Clarify webcam as Phase 1 Video input mechanism; chassis camera is Phase 2.
**Amendment 2:** Activate A.13 for Phase 1 guardian review UI of Planning-generated procedures only.

---

*Reviewed by Canon -- Project Integrity Guardian*
