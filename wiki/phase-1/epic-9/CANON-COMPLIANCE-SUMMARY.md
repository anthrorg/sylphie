# Epic 9: CANON Compliance — Executive Summary

**Verdict: COMPLIANT WITH CRITICAL CONSTRAINTS**

---

## Quick Assessment

Epic 9 (Dashboard API and WebSocket Gateways) is **philosophically sound and architecturally aligned** with the CANON. The epic respects the five-subsystem architecture, maintains drive isolation, protects the WKG, and enforces the Six Immutable Standards.

**One critical assumption:** The Web Module is a **surface transport layer** (read-only observation), not a 6th subsystem. All cognitive decisions and learning remain in the five core subsystems.

---

## Core Findings

### Philosophy Alignment: ✅ PASS

| Principle | Status | Notes |
|-----------|--------|-------|
| Five subsystems untouched | ✅ | Web Module reads from shared stores, never modifies core logic |
| LLM is voice, not mind | ✅ | Web visualizes graph; LLM remains optional scaffolding |
| WKG is the brain | ✅ | Graph API is read-only; all writes through Knowledge module |
| Drive isolation preserved | ✅ | Web reads via read-only interface; no evaluation function writes |

---

### Six Immutable Standards: ✅ PASS

| Standard | Requirement | Epic 9 Implementation |
|----------|-------------|----------------------|
| 1. Theater Prohibition | Responses must correlate with drive state | Dashboard shows drive state + response together |
| 2. Contingency Requirement | Every reinforcement traces to behavior | Web exposes input→behavior→outcome chains |
| 3. Confidence Ceiling | No knowledge exceeds 0.60 without retrieval | Graph API respects ceiling, enforced at Knowledge layer |
| 4. Shrug Imperative | Signal incomprehension when uncertain | Web can represent "I don't know" states |
| 5. Guardian Asymmetry | Guardian feedback = 2-3x weight | Feedback weighted at Communication layer, not Web |
| 6. No Self-Modification | Evaluation function is write-protected | Drive rules read-only; proposals queued for approval |

---

### Architecture Boundaries: ✅ PASS

**Web Module imports:**
- ✅ IDriveStateReader (read-only)
- ✅ WKGInterface (read-only)
- ✅ ConversationService (delegates input through Communication)
- ✅ TimescaleDB event interface

**Web Module must NOT:**
- ❌ Import DriveEvaluator (evaluation logic)
- ❌ Import LearningConsolidation (graph writes)
- ❌ Bypass Communication layer for input
- ❌ Direct Neo4j write access

---

### Phase Boundaries: ✅ PASS

**In Scope (Phase 1 — Cognitive):**
- HTTP/WebSocket interfaces to cognitive state
- Conversation history and input
- Drive state telemetry
- Development metrics

**Out of Scope (Phase 2 — Physical):**
- Camera endpoints, motor control
- Physical sensor fusion
- Embodied exploration metrics

---

## Critical Enforcement Requirements

### 1. No Drive Override Endpoints
**MUST NOT exist:**
```
POST /api/drive/{id}/set
POST /api/drive/{id}/override
DELETE /api/drive/*
```
These violate Standard 6. If inherited from v1 code, remove them.

### 2. Chat Input Routing
**MUST flow through Communication:**
```
POST /api/chat → Communication.parseInput() → Decision Making
NOT directly into decision making
```

### 3. WKG Access Layer
**MUST be read-only:**
- Neo4j database-layer: read-only user credentials
- Application-layer: no write/upsert/delete methods on WKGInterface
- Visual feedback: low-confidence nodes flagged as LLM-generated

### 4. Guardian Feedback Awareness
**MUST show provenance and ask confirmation** before accepting feedback on low-confidence nodes:
```
Node: "Jim loves coffee" (confidence 0.38, LLM_GENERATED)
⚠️ Low confidence, LLM-generated.
Is this actually true? [Yes] [No, delete]
```

---

## Implementation Checklist

**Must Have:**
- [ ] Health check endpoint
- [ ] Drive state read-only API + WebSocket
- [ ] WKG query (read-only) + visualization
- [ ] Chat endpoint (routes through Communication)
- [ ] Guardian feedback endpoint
- [ ] All 7 primary metrics exposed
- [ ] Response includes drive state
- [ ] Drive rules are read-only

**Should Have:**
- [ ] Lesion test control (disable LLM)
- [ ] Metrics dashboard (Type 1/Type 2 graphed)
- [ ] Contingency explorer (input → outcome)
- [ ] Guardian feedback form (provenance-aware)

**Must NOT Have:**
- [ ] Drive override endpoints
- [ ] Graph write endpoints
- [ ] Direct Neo4j write access
- [ ] Phase 2 endpoints (cameras, motors)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Dashboard becomes control panel | Violates Standard 6 | Make all drive/rule modification read-only; proposals only |
| Hallucinated knowledge amplifies | LLM_GENERATED nodes lock in | Flag low-confidence nodes visually; prompt confirmation |
| Input bypasses Communication layer | Breaks contingency tracking | Route all input through Communication, not directly to Decision Making |
| Graph queries become slow | Performance degradation | Timeout queries at 5s; return truncated results with guidance |
| Chat input becomes unconstrained LLM access | Breaks Type 1/Type 2 dynamics | Chat goes through Communication layer's Type 1/Type 2 arbitration |

---

## Development Metrics (What to Expose)

Epic 9 must expose these seven Primary Health Metrics:

1. **Type 1 / Type 2 ratio** — Shows autonomy from LLM
2. **Prediction MAE** — Shows world model accuracy
3. **Experiential provenance ratio** — Shows self-constructed vs. LLM-provided knowledge
4. **Behavioral diversity index** — Shows action variety (stable at 4-8 types per 20 actions)
5. **Guardian response rate** — Shows comment quality (goal: increasing)
6. **Interoceptive accuracy** — Shows self-awareness fidelity (goal: >0.6)
7. **Mean drive resolution time** — Shows need satisfaction efficiency (goal: decreasing)

All queryable with time windows: `/api/metrics/{metric}?since=7d&until=today`

---

## What This Means for Implementation

### Web Module Role
The Web Module is a **translator**, not a **coordinator**. It converts domain model objects (drive state, graph nodes, episodes) into HTTP/WebSocket messages for human observation. It has zero business logic; decisions remain in the five core subsystems.

### Guardian Interaction Pattern
The guardian (Jim) does not control Sylphie through the dashboard. The guardian:
- Observes her state (drive, graph, predictions)
- Provides feedback through chat (text input, weighted 2-3x)
- Reviews metrics to track development
- Approves rule proposals (if Sylphie proposes them)

The dashboard is a **window into Sylphie**, not a **control panel over Sylphie**.

### Development Visibility
By exposing the seven primary metrics, the guardian can see whether Sylphie is developing (Type 1/Type 2 ratio increasing, prediction accuracy stabilizing, provenance ratio improving) or delegating (metrics flat, LLM still dominating).

---

## Approval Path

This epic is ready for:
1. ✅ Detailed design (architecture diagrams, endpoint specifications)
2. ✅ Implementation planning (team assignments, timeline)
3. ✅ Code review (against the constraints in the full review)
4. ⚠️ Testing plan (must include lesion test validation and metric verification)

**No CANON changes required.** The epic aligns with existing architecture.

---

**Prepared by:** Canon, Project Integrity Guardian
**Date:** 2026-03-29
**Status:** READY FOR DETAILED PLANNING

For the full compliance review with detailed endpoint specifications, see: `CANON-COMPLIANCE-REVIEW.md`
