# Epic 6: Communication Subsystem -- Complete Analysis Package

This directory contains the complete detailed analysis for Epic 6: Communication (Input/Output + Person Modeling).

## Files in This Directory

### 1. **EXECUTIVE-SUMMARY.md** (2 min read)
High-level overview for decision makers. Start here if you need a quick understanding of:
- What Epic 6 delivers
- Critical constraints (Theater Prohibition, latency, isolation)
- Feasibility and risks
- Ticket summary and timeline
- Success criteria

**Audience:** Leadership, project managers, decision makers

---

### 2. **EPIC-6-ANALYSIS-VOX.md** (30 min read)
The comprehensive technical analysis. Contains:

**Sections:**
- **Executive Summary** — Scope, dependencies, key constraints
- **1. Feasibility Assessment** — Per-component feasibility matrix
- **2. Proposed Approach** — Detailed architecture for each of 8 components:
  - Input Parser Service
  - Person Modeling (Grafeo isolation)
  - LLM Service (Claude API integration)
  - Response Generator (context assembly + Theater validation)
  - Theater Validator (emotional valence correlation)
  - STT Pipeline (Whisper API)
  - TTS Pipeline (sentence-level streaming)
  - Chatbox Interface (WebSocket)
- **3. Risks and Mitigations** — 5 major risks with detailed mitigation strategies
- **4. v1 Code Reuse Assessment** — What can be lifted from co-being repo
- **5. Proposed Ticket Breakdown** — 12 detailed tickets with dependencies
- **6. Drive State Injection Strategy** — How drive state flows into LLM context
- **7. Other KG Isolation Enforcement** — Type-level and architectural isolation
- **8. Social Comment Quality Implementation** — 30-second window tracking
- **9. Event Emission Strategy** — Learnable event tagging rules
- **10. Summary: Critical Success Factors** — 7 key implementation requirements
- **11. Module Structure Diagram** — File organization reference
- **Appendix** — Reference information

**Key Design Patterns:**
- Drive state injection (mandatory on all LLM calls)
- Person KG isolation (strict architectural boundary)
- Theater validation (post-generation response checking)
- Social drive contingency (30-second response window)

**Audience:** Technical leads, architects, detailed implementers

---

### 3. **TICKETS-TEMPLATE.md** (15 min read per ticket)
Detailed templates for all 12 implementation tickets. Use these as starting points for creating Jira/GitHub issues.

**Tickets Included:**
- **E6-T001:** Type system & interfaces (M, 2 days)
- **E6-T002:** Communication module & DI (M, 2 days)
- **E6-T003:** Input Parser Service (L, 5 days)
- **E6-T004:** Person Modeling (L, 5 days)
- **E6-T005:** LLM Service & cost tracking (M, 3 days)
- **E6-T006:** Response Generator (L, 6 days)
- **E6-T007:** Theater Validator (M, 3 days)
- **E6-T008:** STT Pipeline (M, 2 days)
- **E6-T009:** TTS Pipeline (L, 4 days)
- **E6-T010:** Chatbox Interface (M, 3 days)
- **E6-T011:** Social Drive Contingency (M, 2 days)
- **E6-T012:** Integration tests & benchmarks (L, 5 days)

**Each Ticket Template Contains:**
- Title and size estimate
- Detailed description and deliverables
- Key methods/interfaces to implement
- Acceptance criteria (specific, testable)
- Dependencies and notes

**Audience:** Implementation engineers, ticket creators

---

## Quick Navigation

### For Different Audiences

**If you're a decision maker:**
1. Read EXECUTIVE-SUMMARY.md (2 min)
2. Check success criteria section
3. Review timeline and resource estimate

**If you're an architect:**
1. Read EXECUTIVE-SUMMARY.md (2 min)
2. Read sections 1-7 of EPIC-6-ANALYSIS-VOX.md (critical architecture)
3. Review module structure diagram (section 11)

**If you're implementing:**
1. Read EXECUTIVE-SUMMARY.md to understand scope
2. Read EPIC-6-ANALYSIS-VOX.md sections 2-8 for your component(s)
3. Use TICKETS-TEMPLATE.md to create detailed implementation tickets
4. Reference isolation/drive injection strategies during coding

**If you're testing:**
1. Read EPIC-6-ANALYSIS-VOX.md section 9 (event emission)
2. Read TICKETS-TEMPLATE.md E6-T012 (integration tests)
3. Design isolation tests, latency benchmarks, cost tracking tests

---

## Critical Concepts

### Theater Prohibition (Immutable Standard 1)
Every LLM response must match Sylphie's actual drive state. Responses with emotion that doesn't correspond to drive values are flagged as Theater and receive zero reinforcement.

**Implementation:** Drive state injection + post-generation validation + re-generation on detection

### Other KG Isolation
Person models (Person_Jim, etc.) in Grafeo instances must NEVER cross-contaminate WKG or Self KG. This is enforced at the type level and through strict DI patterns.

**Implementation:** Private Grafeo storage, sanitized public interface, type-level enforcement

### Latency Threshold
Response time (from guardian's last word to Sylphie's first word) must be < 2 seconds. Achieved through parallel TTS synthesis and sentence-level streaming.

**Implementation:** Sentence splitting, parallel synthesis, queue-based playback

### Social Drive Contingency
If guardian responds to Sylphie-initiated comment within 30 seconds, Sylphie gets extra reward. This requires accurate timestamping and causal linking.

**Implementation:** SocialCommentQualityTracker, 35-second window with tolerance, Drive Engine event consumption

---

## Architecture Diagram

```
Communication Subsystem (Epic 6)
├── Input Layer
│   ├── STT (Whisper) → Text
│   ├── Chatbox (WebSocket) → Text
│   └── Input Parser → ParsedInput
│
├── Processing Layer
│   ├── Person Modeling (Other KG via Grafeo) [isolated]
│   ├── Context Assembly (WKG + drive state)
│   └── LLM Service (Claude API)
│
├── Generation & Validation Layer
│   ├── Response Generator → Text
│   └── Theater Validator → validate(response, driveState)
│
└── Output Layer
    ├── TTS (OpenAI) → Audio
    └── Chatbox (WebSocket) → Text

Key Flows:
1. Input: [STT/Text] → [Parser] → [decision making]
2. Output: [decision making] → [Context+Drive] → [LLM] → [Theater check] → [TTS/Chatbox]
3. Person: [Conversation] → [PersonModelingService] → [isolated Grafeo]
4. Social: [Sylphie comment] → [SocialCommentQualityTracker] → [response detected?] → [event]
```

---

## File Organization (Post-Implementation)

```
src/communication/
├── communication.module.ts
├── types.ts
├── exceptions/
│   ├── stt-degradation.error.ts
│   └── tts-degradation.error.ts
├── input-parsing/
│   ├── input-parser.service.ts
│   └── deterministic-classifier.service.ts
├── person-modeling/
│   ├── person-modeling.service.ts
│   └── person-modeling.module.ts
├── llm/
│   ├── llm.service.ts
│   └── cost-tracker.service.ts
├── response-generation/
│   ├── response-generator.service.ts
│   ├── context-assembler.service.ts
│   └── drive-narrative.builder.ts
├── theater/
│   ├── theater-validator.ts
│   └── emotional-valence-analyzer.ts
├── voice/
│   ├── stt.service.ts
│   ├── tts.service.ts
│   └── audio-controller.ts
├── chatbox/
│   ├── chatbox.gateway.ts
│   └── conversation.service.ts
├── social-drive/
│   └── social-comment-quality-tracker.ts
├── events/
│   └── communication-events.ts
└── __tests__/
    └── [integration & unit tests]
```

---

## Next Steps

### Phase 1: Planning
1. Review this analysis with all stakeholders
2. Validate assumptions and constraints
3. Assign epic lead and ticket owners
4. Create Jira/GitHub tickets from TICKETS-TEMPLATE.md

### Phase 2: Implementation
1. Start with E6-T001 & E6-T002 in parallel (types + DI)
2. Continue with parallel tracks:
   - Track 1: T003 (Input Parser)
   - Track 2: T004 (Person Modeling)
   - Track 3: T005 (LLM Service)
3. Follow critical path: T005 → T006 → T009
4. Integrate and test with T012

### Phase 3: Validation
1. Run integration test suite
2. Verify latency profile meets 2-second threshold
3. Validate Theater Prohibition enforcement
4. Test Person KG isolation
5. Measure cost tracking accuracy
6. Load test with concurrent users

---

## Key Metrics to Track

| Metric | Target | Notes |
|--------|--------|-------|
| Response latency (p50) | < 1000ms | Total time from input to output |
| Response latency (p95) | < 2000ms | 2-second hard threshold |
| Theater detection accuracy | > 90% | False positive rate < 10% |
| Cost per response | < $0.02 | Budget: $100/month at 5000 responses |
| Person KG isolation | 100% | Zero cross-contamination |
| Social contingency detection | > 95% | Within 35-second window |

---

## Questions & Escalations

**Q: Why is Theater Prohibition so critical?**
A: If Sylphie can learn to perform emotions she doesn't have, the system breaks. The personality is driven by authentic contingencies, not performed emotions.

**Q: What if latency exceeds 2 seconds?**
A: Guardian experience degrades. The system should fall back to pre-computed responses or text-only mode while optimizing the pipeline.

**Q: Can we simplify Person KG isolation?**
A: No. Cross-contamination would allow Sylphie's self-model to be polluted with observations about other people. Isolation is architectural, not optional.

**Q: How do we handle multiple guardians?**
A: Each guardian gets an isolated Grafeo instance (Person_Jim, Person_Guardian2, etc.). The system learns different communication patterns for each.

---

## Version History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-03-29 | 1.0 | Vox | Initial comprehensive analysis |

---

**Analysis prepared by:** Vox, Communication Subsystem Engineer  
**Validated by:** CANON (wiki/CANON.md)  
**Ready for:** Epic planning and implementation
