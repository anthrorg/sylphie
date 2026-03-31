# Epic 9: Dashboard API and WebSocket Gateways

**Status:** Pre-Implementation (Ready for Detailed Design)
**Verdict:** COMPLIANT WITH CRITICAL CONSTRAINTS
**Key Constraint:** Web Module is a read-only observation layer, not a control panel

---

## Documentation Overview

This epic directory contains four documents:

### 1. CANON-COMPLIANCE-REVIEW.md
**The primary review document.** Comprehensive analysis of Epic 9 against all CANON principles and constraints.

**Contents:**
- Philosophy alignment (five-subsystem architecture)
- Six Immutable Standards compliance
- Architecture boundary validation
- Phase scope verification
- Development metrics specification
- Risks and mitigations
- Detailed endpoint patterns

**Read this if:** You're the project lead or epic architect needing a thorough compliance assessment.

---

### 2. CANON-COMPLIANCE-SUMMARY.md
**Executive summary.** Quick verdict and high-level findings for project leadership.

**Contents:**
- Verdict (COMPLIANT WITH CRITICAL CONSTRAINTS)
- Core findings (philosophy, standards, architecture, phase boundaries)
- Critical enforcement requirements
- Implementation checklist
- Risk summary
- Development metrics overview

**Read this if:** You need a 5-minute overview or are presenting to stakeholders.

---

### 3. ARCHITECT-ENDPOINT-GUIDE.md
**Detailed endpoint specifications.** Reference for API designers during the design phase.

**Contents:**
- Organized by functional area (Health, Drives, Graph, Chat, Metrics, Admin)
- Complete request/response examples
- CANON alignment annotations for each endpoint
- Authentication and rate limiting
- Error response patterns

**Read this if:** You're designing the API and need concrete endpoint patterns validated against CANON.

---

### 4. README.md (this file)
**Navigation guide.** Points you to the right document based on your role.

---

## For Different Roles

### Project Leadership
1. Read **CANON-COMPLIANCE-SUMMARY.md** (5 minutes)
2. Skim **CANON-COMPLIANCE-REVIEW.md** sections 1-2 (15 minutes)
3. Verdict: Epic is approved to move to detailed design

### Epic Architect
1. Read **CANON-COMPLIANCE-REVIEW.md** in full (30 minutes)
2. Use **ARCHITECT-ENDPOINT-GUIDE.md** as reference during design
3. Validate your endpoint designs against the checklist in section 8

### API Designer
1. Skim **CANON-COMPLIANCE-REVIEW.md** section 3 (architecture boundaries)
2. Deep-dive **ARCHITECT-ENDPOINT-GUIDE.md** (structure your API against these patterns)
3. Every endpoint you write should have a counterpart in the guide

### Developer (Implementation Phase)
1. Read **ARCHITECT-ENDPOINT-GUIDE.md** for your assigned endpoints
2. Reference **CANON-COMPLIANCE-REVIEW.md** section 2 (Six Immutable Standards) as you code
3. Use the checklist in section 8 to validate before code review

---

## Critical Enforcement Requirements

These five constraints are **non-negotiable**. If any are violated, the epic fails CANON compliance:

### 1. Chat Input Routes Through Communication
```
NOT: POST /api/decision/action
YES: POST /api/chat → Communication.parseInput() → Decision Making
```

### 2. WKG Access Is Read-Only
```
NOT: POST /api/graph/upsert, DELETE /api/graph/node
YES: GET /api/wkg/query (read-only queries)
```

### 3. Drive State Is Read-Only
```
NOT: POST /api/drive/curiosity/set, POST /api/drive/override
YES: GET /api/drives (read-only view)
```

### 4. Drive Rules Are Read-Only
```
NOT: POST /api/drive-rules (creates immediately)
YES: POST /api/drive-rules-proposal (queued for guardian approval)
```

### 5. No Drive Override Endpoints
Remove any v1 patterns like:
```
POST /api/drive/{id}/set
PUT /api/drive/{id}/value
DELETE /api/drive/*
```

---

## Quick Checklist for Implementation

**Must-Have:**
- [ ] Health check endpoint (all subsystems + databases)
- [ ] Drive state API (read-only) + WebSocket feed
- [ ] WKG query API (read-only) + WebSocket feed
- [ ] Chat API (routes through Communication) + WebSocket
- [ ] Guardian feedback endpoint
- [ ] All 7 primary metrics exposed
- [ ] Response includes drive state
- [ ] Drive rules are read-only

**Should-Have:**
- [ ] Lesion test control (disable LLM for testing)
- [ ] Metrics dashboard (Type 1/Type 2 graphed over time)
- [ ] Contingency explorer (input → outcome chains)
- [ ] Guardian feedback form (provenance-aware)

**Must NOT Have:**
- [ ] No `/api/drive/*/set` or override endpoints
- [ ] No `/api/graph/upsert` or write endpoints
- [ ] No Phase 2 endpoints (cameras, motors)

---

## Key Design Principles

### The Web Module Is a Translator, Not a Coordinator

The Web Module converts domain objects (drive state, graph nodes, episodes) into HTTP/WebSocket messages. It has **zero business logic**. All cognition remains in the five core subsystems.

### The Guardian Does Not Control Sylphie Through the Dashboard

The guardian observes Sylphie's state and provides feedback through chat (text input). The dashboard is a **window into Sylphie**, not a **control panel over Sylphie**.

### Development Is Visible Through Metrics

By exposing the seven primary metrics, the guardian can see whether Sylphie is developing (Type 1/Type 2 ratio increasing, prediction accuracy improving) or delegating (metrics flat, LLM still dominating).

---

## What "COMPLIANT WITH CRITICAL CONSTRAINTS" Means

Epic 9 is **philosophically sound and architecturally aligned** with the CANON. It respects the five-subsystem architecture, maintains drive isolation, protects the WKG, and enforces the Six Immutable Standards.

**However**, this compliance is contingent on enforcing the five critical constraints above during implementation. If those constraints are violated, the epic becomes non-compliant.

---

## Next Steps

1. **Detailed Design Phase**
   - Review ARCHITECT-ENDPOINT-GUIDE.md
   - Design API schemas and data models
   - Create architecture diagrams
   - Validate against the endpoint checklist

2. **Implementation Planning**
   - Assign team members to endpoint groups
   - Create implementation subtasks
   - Plan testing strategy (including lesion test validation)

3. **Code Review Validation**
   - Every endpoint reviewed against ARCHITECT-ENDPOINT-GUIDE.md
   - Checklist in CANON-COMPLIANCE-REVIEW.md section 8 verified
   - No drive override endpoints present

---

## Questions or Clarifications?

If the CANON alignment is unclear:

1. Check **CANON-COMPLIANCE-REVIEW.md** section corresponding to your question
2. Reference the specific "Immutable Standard" or architectural principle
3. Escalate to project leadership if the constraint conflicts with a requirement

All conflicts should be resolved before implementation begins.

---

**Prepared by:** Canon, Project Integrity Guardian
**Date:** 2026-03-29
**Status:** READY FOR DETAILED DESIGN

---

**Documents in this directory:**
- `CANON-COMPLIANCE-REVIEW.md` — Full compliance analysis
- `CANON-COMPLIANCE-SUMMARY.md` — Executive summary
- `ARCHITECT-ENDPOINT-GUIDE.md` — Endpoint specifications
- `README.md` — This file (navigation guide)
