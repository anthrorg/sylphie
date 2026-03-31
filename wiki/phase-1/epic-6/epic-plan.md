# Epic 6: Communication (Input/Output + Person Modeling)

## Summary

Epic 6 implements the Communication subsystem — the interface between Sylphie and the world. It is how she speaks, how she listens, how she understands the people she talks to, and how the interaction feels. The LLM provides immediate communicative competence from session one, but every conversation feeds the Learning subsystem. Over time, the graph shapes responses increasingly; the Communication subsystem is the translator between internal state and external expression.

This epic builds: Input Parser (LLM-mediated input interpretation), Response Generator (LLM response with drive state injection), Theater Prohibition enforcement (zero reinforcement for performed emotions), Person Modeling via Other KG (Grafeo per-person instances), Voice Pipeline (STT via Whisper, TTS via OpenAI), Chatbox Interface (WebSocket gateway), LLM Service (Claude API with cost tracking), and Social Comment Quality tracking (30-second window).

## Why This Epic Matters

1. **Sylphie's voice** — Without Communication, Sylphie cannot interact with the guardian. No interaction means no learning, no drive relief, no personality development. Communication is the bottleneck between accumulated experience and meaningful growth.

2. **Theater Prohibition enforcement** — Immutable Standard 1. The most important behavioral constraint in the system. Communication is the last line of defense before output reaches the guardian. If Sylphie performs emotions she doesn't have, the entire behavioral contingency structure is undermined.

3. **Person modeling** — Understanding who Jim is, what he cares about, how he communicates. Without person models, Sylphie treats every interaction as if meeting a stranger. Person models enable the social sensitivity that makes interaction worthwhile.

4. **Type 2 cost tracking** — Every LLM call must carry explicit cost. Without cost reporting, the LLM always wins and Type 1 never develops. Communication owns the primary LLM integration and therefore the primary cost surface.

5. **Learning fuel** — Communication events tagged `has_learnable=true` feed the Learning subsystem. Without proper event emission, the graph starves. Communication is the primary producer of learnable material.

## CANON Alignment

### Relevant Principles
- **"The LLM is her voice, not her mind"** — Communication translates; Decision Making decides
- **Theater Prohibition (Immutable Standard 1)** — Output correlates with drive state
- **Guardian Asymmetry (Immutable Standard 5)** — Corrections 3x, confirmations 2x
- **Provenance Is Sacred** — All communication-derived knowledge tagged LLM_GENERATED
- **Type 2 carries cost** — Every LLM call tracked and reported to Drive Engine

### CANON Gaps Addressed (Defaults, Flagged for Jim)
- **A.6 (LLM Context Assembly Protocol)** — Default: all 12 drive values + natural language narrative + Theater instruction + person model + WKG context + conversation history. Token budget managed by priority.
- **A.7 (Communication Parser Specification)** — Default: LLM-assisted parsing with 6 intent types, entity extraction cross-referenced with WKG, guardian feedback detection, all tagged LLM_GENERATED at 0.35 base.
- **A.6.1 (Other KG Isolation Protocol)** — Default: per-person Grafeo instances, no shared nodes/edges with WKG or Self KG, all person model nodes tagged INFERENCE or LLM_GENERATED.

## Ticket Summary (13 tickets)

| ID | Title | Complexity | Dependencies |
|----|-------|-----------|-------------|
| E6-T001 | Communication Types & Interface Refinement | M | - |
| E6-T002 | CommunicationModule Skeleton & DI Wiring | M | T001 |
| E6-T003 | LLM Service (Claude API + Cost Tracking) | M | T002 |
| E6-T004 | Input Parser Service (LLM-Mediated) | L | T002, T003 |
| E6-T005 | LLM Context Assembler (A.6 Default) | L | T003 |
| E6-T006 | Theater Validator Service | M | T001 |
| E6-T007 | Response Generator Service | L | T003, T005, T006 |
| E6-T008 | Person Modeling Service (Other KG / Grafeo) | L | T002 |
| E6-T009 | Voice Pipeline (STT + TTS) | M | T002 |
| E6-T010 | Chatbox WebSocket Gateway | M | T002 |
| E6-T011 | Social Drive Contingency Tracker | M | T002 |
| E6-T012 | CommunicationService Facade (Public API) | L | T003-T011 |
| E6-T013 | Integration Tests & End-to-End Verification | L | T012 |

## Parallelization

```
E6-T001 (Types & Interfaces)
  |
  v
E6-T002 (Module Skeleton)
  |
  +------ E6-T003 (LLM Service) ──────────────────────┐
  |            |                                        |
  |            +── E6-T004 (Input Parser)               |
  |            |                                        |
  |            +── E6-T005 (Context Assembler) ─────┐   |
  |                                                 |   |
  +------ E6-T006 (Theater Validator) ──────────────+───+
  |                                                 |   |
  +------ E6-T008 (Person Modeling) ────────────────+   |
  |                                                 |   |
  +------ E6-T009 (Voice STT/TTS) ─────────────────+   |
  |                                                 |   |
  +------ E6-T010 (Chatbox Gateway) ───────────────+   |
  |                                                 |   |
  +------ E6-T011 (Social Contingency) ────────────+   |
                                                    |   |
                                                    v   v
                                          E6-T007 (Response Generator)
                                                    |
                                                    v
                                          E6-T012 (Facade)
                                                    |
                                                    v
                                          E6-T013 (Integration Tests)
```

After T002, tickets T003, T006, T008, T009, T010, and T011 can all proceed in parallel. T004 and T005 depend on T003. T007 depends on T003, T005, and T006. The facade (T012) and integration tests (T013) are serial at the end.

Critical path: T001 → T002 → T003 → T005 → T007 → T012 → T013

## Agent Cross-Examination Summary

### Key Agreements (All Agents)
- Theater Prohibition needs multi-layer enforcement: prompt injection + post-generation validation + zero reinforcement
- Other KG isolation must be enforced architecturally (separate Grafeo instances, no shared nodes)
- Type 2 cost tracking is non-negotiable on every LLM call
- ~13 tickets is the right scope for this epic
- CANON gaps A.6 and A.7 need reasonable defaults before implementation

### Key Tensions Resolved

**Skinner: Social contingency risk**
Skinner warned the 30-second window could create an attractor where Sylphie optimizes for response speed over quality. Resolution: the contingency triggers on WHETHER the guardian responds, not response speed. Quality is measured by the guardian choosing to engage.

**Piaget: Person model developmental trajectory**
Piaget emphasized person models should start simple and grow through experience. Resolution: T008 implements basic person model schema that grows organically through `updateFromConversation()` — no pre-populated models.

**Canon: Blocking gaps**
Canon identified A.6, A.7, and Other KG isolation as blocking concerns. Resolution: reasonable defaults defined in this epic plan, flagged for Jim's review. Implementation can proceed with these defaults.

**Cortex: Interface boundary**
Cortex emphasized the clean separation: Decision Making selects WHAT, Communication implements HOW. Resolution: ActionIntent type defines the contract. Communication never selects actions; it translates intent to speech.

### Behavioral Predictions (Skinner)
- Social comment quality will produce discrimination training — Sylphie learns what's worth saying
- Theater Prohibition zero-reinforcement will extinguish performed emotions within ~20 sessions
- Guardian correction handling (3x weight) will shape authentic acknowledgment over performative apology
- Risk: "Chameleon Attractor" — Sylphie mirrors guardian emotional tone. Prevention: drive state is the ground truth, not guardian emotion.

### Developmental Predictions (Piaget)
- Early communication: 95% LLM-dependent, 5% graph-informed
- Mid development: 60% LLM, 40% graph (recurring topics handled from knowledge)
- Late Phase 1: 30% LLM, 70% graph (most interactions draw from accumulated knowledge)
- Person model accuracy improves with guardian correction frequency
- Horizontal decalage expected: topics Jim discusses frequently develop faster

## v1 Code Reuse

| Component | v1 Source | Reuse Level |
|-----------|----------|-------------|
| Input Parser | conversation-engine/input-parser.service.ts | Structure only (clean-room for LLM-mediated approach) |
| Person Model | reasoning-engine/person-model.service.ts | PersonNode/Snapshot concepts (adapt for Grafeo) |
| Voice Pipeline | backend/src/voice/ | Pattern reuse (OpenAI API patterns) |
| WebSocket | backend/web/conversation.gateway.ts | Pattern reuse (NestJS gateway adaptation) |
| Context Assembly | reasoning-engine/decomposition.service.ts | Conceptual only (v2 is drive-aware, v1 was not) |
| Theater Validator | N/A | Entirely new (v1 had no Theater Prohibition) |
| LLM Service | maintenance-engine/maintenance-llm.service.ts | API patterns only |

## Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Theater validation false positives | Medium | Tunable threshold (0.4 default), ambiguous zone handling |
| LLM ignoring drive state | Medium | Multi-layer enforcement (prompt + validation + zero reinforcement) |
| Person model isolation breach | High | Architectural enforcement (separate Grafeo, no shared IDs) |
| Response latency > 2s | Medium | Sentence-level TTS streaming, pre-computed acknowledgments |
| Grafeo availability/maturity | Medium | Evaluate alternatives if needed (same risk as E3) |
| LLM cost spiral | Low | Token budget per call, configurable limits |

## Success Criteria

Epic 6 is complete when:
1. Guardian can type a message and receive a drive-authentic response
2. Guardian can speak and receive a spoken response (with text fallback)
3. Theater Prohibition enforced on every response (zero reinforcement on Theater)
4. Person model created and updated from conversation (isolated in Other KG)
5. Every LLM call has a corresponding cost event in TimescaleDB
6. Social contingency tracked (30-second window for Sylphie-initiated comments)
7. All communication events in TimescaleDB with appropriate has_learnable tagging
8. `npx tsc --noEmit` passes
9. Integration tests pass for all 9 test areas
