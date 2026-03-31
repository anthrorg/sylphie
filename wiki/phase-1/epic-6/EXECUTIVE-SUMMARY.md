# Epic 6: Communication Subsystem -- Executive Summary

**Status:** Analysis Complete
**Scope:** 8 components, 12 tickets, 18-21 days of implementation
**Lead:** Vox (Communication engineer)
**Risk Level:** Medium (Theater Prohibition validation and latency management are tight)

---

## What This Epic Delivers

Epic 6 builds the complete Communication subsystem: how Sylphie listens (input parsing), understands the person she's talking to (person modeling via isolated Grafeo), speaks authentically (LLM with Theater Prohibition enforcement), and delivers output (voice + chatbox).

**Eight Components:**
1. Input Parser — Parse text/voice into intents and entities
2. Person Modeling — Isolated per-person KGs (Grafeo) for modeling guardians
3. LLM Service — Claude API integration with cost tracking
4. Response Generator — Assemble context, inject drive state, generate response
5. Theater Validator — Validate response matches actual drive state
6. STT Pipeline — OpenAI Whisper with graceful text fallback
7. TTS Pipeline — OpenAI TTS with sentence-level streaming for latency
8. Chatbox Interface — WebSocket for text-only conversation

---

## Critical Constraints

### Theater Prohibition (Immutable Standard 1)
**What:** Every response must match Sylphie's actual drive state. No performing emotions she doesn't have.

**How it's enforced:**
- Drive snapshot injected into every LLM call
- Post-generation validation: compute emotional valence vs. drive valence
- Correlation < 0.4 → flagged as theater, asking LLM to regenerate
- Theater responses get zero reinforcement (Drive Engine multiplier = 0.0)

### Latency Threshold (2 seconds)
**What:** From guardian's last word to Sylphie's first word: < 2 seconds.

**How it's achieved:**
- Parallel synthesis: while LLM generates text, begin TTS on first sentence
- Sentence-level streaming: play sentence 1 while synthesizing sentence 2
- Pre-computed acknowledgments: cache "I see", "Hmm", "Okay"
- Latency budgeting: context 300ms, LLM 1000ms, TTS 500ms, playback 200ms = 2000ms

### Other KG Isolation
**What:** Person models (Person_Jim, etc.) in isolated Grafeo instances cannot cross-contaminate WKG or Self KG.

**How it's enforced:**
- Grafeo instances stored privately in PersonModelingService
- Public interface returns sanitized PersonModel objects, never graph references
- All queries use graph-sealed instances with no edges to WKG/Self KG
- Type system: _grafeoGraph is private property, not exported

### Social Drive Contingency (30-second window)
**What:** If guardian responds to Sylphie-initiated comment within 30 seconds, she gets extra reward (Social -0.15 + Satisfaction +0.10).

**How it's tracked:**
- SocialCommentQualityTracker timestamps each Sylphie comment
- InputParserService detects guardian response and reports to tracker
- Tracker emits event if within 35-second window (35s = 30s + tolerance)
- Drive Engine reads event and applies 2x Guardian weight

---

## Feasibility & Risks

### Feasibility: HIGH
All components are feasible. No experimental APIs, no unknown architectures. Highest complexity is in:
- **TTS latency optimization** (streaming orchestration)
- **Theater Prohibition validation** (emotional valence extraction)
- **Grafeo isolation** (strict DI enforcement)

None are blockers.

### Risks: MEDIUM

| Risk | Mitigation |
|------|-----------|
| Theater validator false positives | Threshold tuning, tolerance band, guardian feedback loop |
| Latency exceeds 2 seconds | Parallel synthesis, streaming, latency monitoring |
| Person KG isolation leakage | Type-level enforcement, private properties, isolation tests |
| Social contingency window misses | 35s tolerance, causal linking, per-comment tracking |
| Cost runaway | Per-subsystem budgets, monitoring, graceful degradation |

---

## v1 Code Reuse

**High-value lift (40-60% code reuse):**
- InputParserService structure (co-being/conversation-engine)
- PersonModelService (co-being/reasoning-engine) — adapt to Grafeo
- ConversationGateway WebSocket pattern (co-being/backend)
- STT/TTS pipeline patterns (co-being/voice)

**Clean-room rewrites (new requirements):**
- Theater Validator (Immutable Standard 1 enforcement)
- Drive injection system prompt (no v1 equivalent)
- Grafeo isolation enforcement (v1 used flat JSON)
- Response re-generation on Theater detection

**Effort with reuse: 20-25 days** (vs. 30+ without)

---

## Ticket Summary (12 Tickets)

| ID | Title | Size | Lead Time |
|----|-------|------|-----------|
| E6-T001 | Type system & interfaces | M | Day 1 |
| E6-T002 | Communication module & DI | M | Day 1 |
| E6-T003 | Input Parser Service | L | Day 3 |
| E6-T004 | Person Modeling (Grafeo) | L | Day 3 |
| E6-T005 | LLM Service & cost tracking | M | Day 3 |
| E6-T006 | Response Generator | L | Day 6 |
| E6-T007 | Theater Validator | M | Day 6 |
| E6-T008 | STT Pipeline | M | Day 6 |
| E6-T009 | TTS Pipeline (streaming) | L | Day 8 |
| E6-T010 | Chatbox Interface (WebSocket) | M | Day 8 |
| E6-T011 | Social Drive Contingency Tracker | M | Day 10 |
| E6-T012 | Integration tests & benchmarks | L | Day 12 |

**Critical path:** T001 → T002 → T005 → T006 → T009/T010 → T012 = **~13 days**

**With parallelization: 18-21 days total**

---

## Key Design Patterns

### Drive State Injection
```typescript
// Every response generation call MUST include drive state
const driveState = await driveService.getCurrentDriveState();
const context = { ...context, driveState };
const systemPrompt = `You are Sylphie. Your state: ${drivesToNarrative(driveState)}`;
```

### Other KG Isolation
```typescript
// Private storage, sanitized public interface
class PersonModelingService {
  private readonly grafeoInstances: Map<string, GrafeoGraph> = new Map(); // private

  async getPersonModel(id: string): PersonModel { // public
    return this.sanitizePersonModel(model); // removes _grafeoGraph
  }
}
```

### Theater Validation
```typescript
// Post-generation: validate response matches drive state
const validation = await theatreValidator.validate(llmResponse, driveState);
if (validation.isTheater) {
  return this.regenerateWithConstraint(context, validation);
}
```

### Social Drive Contingency
```typescript
// Track Sylphie-initiated comment, detect guardian response within 35s
socialCommentTracker.recordInitiatedComment(id, text);
// Later...
socialCommentTracker.recordGuardianResponse(text);
// Emits event if within 35s window → Drive Engine applies reward
```

---

## Dependencies

**Hard Dependencies:**
- **E2 (Events):** All communication events → TimescaleDB
- **E3 (Knowledge):** Entity resolution, WKG context queries
- **E4 (Drive Engine):** Read-only drive state for context injection

**Can be built in parallel with:**
- **E5 (Decision Making):** Communication is I/O layer, independent implementation

---

## Success Criteria

Epic 6 succeeds when:

1. ✓ Theater Prohibition enforced on all LLM responses
2. ✓ Person KG isolation passes all isolation tests (zero WKG cross-contamination)
3. ✓ Response latency < 2 seconds (measured on real hardware)
4. ✓ Social drive contingency detected within 35-second window
5. ✓ All communication events tagged with `has_learnable` correctly
6. ✓ Cost tracked per subsystem and within budget
7. ✓ STT/TTS gracefully degrade to text on failure
8. ✓ All 12 tickets implemented and tested
9. ✓ Integration tests pass: full I/O pipeline, isolation, latency, cost

---

## Next Steps

1. **Validate this analysis** with Guardian (Jim) and other agents
2. **Create detailed implementation tickets** from T001-T012 breakdown
3. **Assign implementers** (Vox for architecture, specialists for voice)
4. **Begin E6-T001** (types) and E6-T002 (DI) in parallel
5. **Monitor critical path:** Ensure T001-T002 → T005 → T006 timeline is met

---

**Analysis prepared by Vox, Communication Subsystem Engineer**
