# Epic 6 Decisions

Technical decisions made during Epic 6 planning. Each decision records what was decided, why, what alternatives were considered, and which CANON principle supports it.

---

## D1: LLM Context Assembly Default (A.6)

**Decision:** Define a default LLM Context Assembly Protocol since CANON A.6 is reserved.

**Default specification:**
1. Always include: all 12 drive values + natural language drive narrative
2. Always include: action intent from Decision Making
3. Always include: Theater Prohibition instruction (directional: pressure expression requires drive > 0.2; relief expression requires drive < 0.3)
4. Always include: person model summary from Other KG
5. Priority include: recent conversation history (last 5-10 turns)
6. Priority include: relevant WKG knowledge (max 10 nodes by topic relevance)
7. Space-permitting: episodic memory summaries
8. Never include: raw drive computation, internal system state, other people's KG data

**Why:** The Communication subsystem cannot be implemented without knowing what context the LLM receives. A.6 is reserved in the CANON, so we define reasonable defaults that align with CANON principles and flag for Jim's review.

**Alternatives considered:**
- Wait for Jim to specify A.6 (blocked implementation)
- Minimal context (drive state only) — insufficient for quality responses
- Maximum context (everything) — exceeds token budget, slow

**CANON reference:** §Core Philosophy 1 ("LLM provides voice"), §Immutable Standard 1 (Theater Prohibition), §Communication subsystem description

**Status:** APPROVED (2026-03-29)

---

## D2: Communication Parser Default (A.7)

**Decision:** Define a default Communication Parser specification since CANON A.7 is reserved.

**Default specification:**
- LLM-assisted parsing (Type 2) for all inputs in Phase 1
- 6 intent types: QUESTION, STATEMENT, CORRECTION, COMMAND, ACKNOWLEDGMENT, TEACHING
- Entity extraction cross-referenced with WKG via findNode()
- Guardian feedback detection: CONFIRMATION, CORRECTION, TEACHING, NONE
- All parsed content tagged LLM_GENERATED provenance at 0.35 base confidence
- Reference resolution for simple anaphora ("it", "that") using conversation thread context
- Events emitted to TimescaleDB with has_learnable=true

**Why:** Input parsing is foundational — without it, Decision Making receives nothing structured. The CANON mentions "whitespace tokenization + LLM-assisted intent classification" in the Known Spec Gaps table, which we follow.

**Alternatives considered:**
- Rule-based parsing only — insufficient for natural language
- Hybrid rule + LLM — premature optimization, start with LLM-assisted
- No parsing (raw text to DM) — Decision Making needs structure

**CANON reference:** §Known Spec Gaps (A.7), §Subsystem 2: Communication

**Status:** APPROVED (2026-03-29)

---

## D3: Other KG Isolation Protocol

**Decision:** Per-person Grafeo instances with strict isolation. Person models contain INFERENCES, not FACTS.

**Specification:**
- One Grafeo instance per person (Map<string, GrafeoGraph>)
- No shared node IDs with WKG, Self KG, or other person KGs
- No edges between any KG stores
- All person model nodes tagged LLM_GENERATED or INFERENCE provenance (never SENSOR or GUARDIAN)
- Public interface returns sanitized PersonModel objects, not raw graph data
- Only PersonModelingService has write access

**Why:** The CANON states "Self KG and Other KG (Grafeo) are completely isolated from each other and from the WKG. No shared edges, no cross-contamination." This must be enforced architecturally, not just by convention.

**Key distinction:** Facts about Jim ("Jim exists", "Jim said X") belong in the WKG with SENSOR/GUARDIAN provenance. Inferences about Jim's mind ("Jim prefers brief responses", "Jim gets frustrated with technical errors") belong in Jim's Other KG with INFERENCE provenance.

**Alternatives considered:**
- Shared Grafeo for all person models — violates isolation requirement
- Person model in WKG — violates KG isolation ("no cross-contamination")
- Person model in PostgreSQL — loses graph structure, harder to query

**CANON reference:** §Architecture ("Self KG and Other KG are completely isolated"), CLAUDE.md §Architectural Boundaries

**Status:** Final.

---

## D4: Theater Prohibition Enforcement Strategy

**Decision:** Three-layer enforcement: prompt injection + post-generation validation + zero reinforcement.

**Layer 1 (Soft — Prompt):**
- Drive state narrative injected into LLM context
- Explicit instruction (directional): "Do not express pressure/distress/urgency for a drive unless it is > 0.2. Do not express relief/contentment/fulfillment for a drive unless it is < 0.3."
- Drives described in natural language, not raw numbers. Drive values range [-10.0, 1.0]; negative values represent extended relief states.

**Layer 2 (Hard — Validation):**
- TheaterValidatorService checks every generated response
- Extracts emotional valence from response text (LLM-assisted lightweight check)
- Computes drive-emotion correlation
- If correlation < 0.4: Theater detected
- On Theater: attempt one regeneration with stronger constraint
- If still Theater: deliver neutral/minimal response

**Layer 3 (Reinforcement — Drive Engine):**
- Theater-detected responses carry reinforcementMultiplier = 0.0
- Even positive guardian responses to theatrical output produce zero learning signal
- This is an extinction procedure for non-contingent emotional expression

**Ambiguous zone (drive 0.2-0.3, the overlap between thresholds):**
- Allow weak emotional expression
- Flag for monitoring but do not zero reinforcement
- Track for behavioral auditing

**Why:** Single-layer enforcement is insufficient. The LLM may ignore prompt instructions (Layer 1 alone fails). Validation alone catches but doesn't prevent (Layer 2 without Layer 1 means frequent regeneration). Zero reinforcement alone doesn't reduce Theater occurrence (Layer 3 without Layers 1-2 means Theater still reaches the guardian). All three layers together create robust enforcement.

**Behavioral science justification (Skinner):** Zero reinforcement is the correct extinction procedure. Even when the guardian responds positively to performed emotions, the system receives no learning signal. Over ~20 sessions, performed emotional expression should extinguish.

**CANON reference:** §Immutable Standard 1 (Theater Prohibition)

**Status:** Final.

---

## D5: Emotion-to-Drive Mapping

**Decision:** Define default emotion-to-drive mapping for Theater validation.

| Emotional Expression | Primary Drive | Secondary Drive |
|---------------------|--------------|----------------|
| Excitement, enthusiasm | Satisfaction | Curiosity |
| Sadness, disappointment | Sadness | - |
| Anxiety, worry, nervousness | Anxiety | - |
| Boredom, disengagement | Boredom | - |
| Social warmth, friendliness | Social | Satisfaction |
| Guilt, remorse, apology | Guilt | - |
| Curiosity, wonder, interest | Curiosity | - |
| Confidence, certainty | Cognitive Awareness (low) | Satisfaction |
| Confusion, uncertainty | Cognitive Awareness (high) | Anxiety |
| Care, concern for self | System Health | - |
| Moral judgment | Moral Valence | - |
| Doubt about own knowledge | Information Integrity | - |

**Why:** Theater validation needs to map expressed emotions to corresponding drives to check correlation. This mapping must be defined before TheaterValidatorService can be implemented.

**Alternatives considered:**
- LLM-only detection (no mapping) — inconsistent, hard to test
- Simple positive/negative valence — too coarse, misses specific emotions
- ML classifier — premature optimization for Phase 1

**CANON reference:** §Immutable Standard 1, §12 Drives table

**Status:** Default, awaiting Jim's review.

---

## D6: Social Comment Quality Window

**Decision:** 30-second window per CANON, with 35-second tolerance for processing delay.

**Implementation:**
- Timestamp Sylphie-initiated utterances (not responses)
- On guardian message: check if any pending utterance within window
- Match: emit SOCIAL_CONTINGENCY_MET event, report to Drive Engine
- Expired entries cleaned up periodically (every 60s)

**Behavioral refinement (Skinner input):**
- Track BOTH whether guardian responds AND engagement quality
- A one-word "ok" is technically within 30s but low engagement
- For Phase 1: any guardian response within window triggers contingency
- For future: weight by response length/quality (deferred to a later epic)

**Why:** The CANON specifies 30 seconds explicitly. We follow the specification directly with minimal tolerance for processing overhead.

**CANON reference:** §Behavioral Contingency Structure → Social Comment Quality

**Status:** Final.

---

## D7: Voice Graceful Degradation

**Decision:** Voice failures always degrade to text. Never block on audio failure.

**STT failure path:**
- Whisper API unavailable or returns garbage → throw STTDegradationError
- Caller catches and prompts guardian for text input
- Event logged to TimescaleDB (STT_FAILURE)

**TTS failure path:**
- OpenAI TTS unavailable → throw TTSDegradationError
- Response delivered as text only via chatbox
- Event logged to TimescaleDB (TTS_FAILURE)

**Pre-computed acknowledgments:**
- Common responses ("I see", "Hmm", "Okay", "Interesting") pre-synthesized on startup
- Used when quick acknowledgment needed during processing
- Cached in memory, refreshed if voice config changes

**Why:** The CANON states Sylphie has both voice and text channels. Audio is preferred, not required. A human teacher would not stop teaching because the student's hearing aid broke — they'd switch to writing.

**CANON reference:** Vox agent profile Rule 12 ("Never block on audio failure")

**Status:** Final.

---

## D8: Ticket Granularity

**Decision:** 13 tickets. Foundation (T001-T002), parallel implementation (T003-T011), integration (T012-T013).

**Why:** This matches the pattern established in Epics 0-5. Each ticket is independently testable, has clear acceptance criteria, and maps to a specific CANON concern. The parallel middle tier (T003-T011) allows maximum concurrency.

**Alternatives considered:**
- Fewer tickets (8-10) — individual tickets too large, harder to track
- More tickets (15-20) — overhead exceeds value for an L-complexity epic
- No voice tickets (defer to later) — CANON specifies STT/TTS in Communication

**Status:** Final.
