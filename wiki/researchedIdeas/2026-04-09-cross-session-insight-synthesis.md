# Research: Cross-Session Insight Synthesis

**Date:** 2026-04-09
**Status:** researched
**Verdict:** yes-with-caveats
**Source:** wiki/ideas/cross-session-insight-synthesis.md

## Idea

Add a second-order reflection pass that compares INSIGHT nodes across different sessions to discover patterns, contradictions, and evolving themes that no single-session reflection can surface. Currently, `ConversationReflectionService` reflects on each session in isolation — it gathers events for one session, sends them to the LLM, and persists insights scoped to that session. Cross-session patterns (evolving preferences, recurring themes across contexts, contradictions over time) go undetected.

## Key Questions

- Is cross-session memory synthesis a solved problem with established prior art, or novel research territory?
- Can this be built within Sylphie's existing Learning subsystem architecture without CANON violations?
- What confidence/provenance model applies to "inferences of inferences"?
- How do we select which insights to compare without blowing the token budget?
- What is the confabulation risk when LLMs reason about their own prior reasoning outputs?

## Findings

### Prior Art

Cross-session memory synthesis is a well-researched problem with multiple production-grade implementations:

**Academic Frameworks:**
- **Reflexion** (NeurIPS 2023): Agents verbally reflect on feedback and maintain episodic memory buffers for better decision-making across trials. Directly analogous to our proposed synthesis pass.
- **ExpeL** (2023): Extracts cross-task insights by comparing successful/failed trajectories, enabling learning from experience across multiple sessions.
- **Meta-Reflection** (ACL 2025): Feedback-free reflection learning that integrates insights into a codebook for retrieval and guidance — closely matches our "compare insights to discover patterns" concept.
- **Reflective Memory Management** (2025): Decomposes dialogue histories into topics, creating coherent memory structures across session boundaries.

**Production Systems:**
- **Mem0**: Two-phase extract→consolidate pipeline with graph-based variant. Reports 26% relative improvement over OpenAI baselines, 91% lower p95 latency, 90% token savings. Open-source at github.com/mem0ai/mem0.
- **ZEP/Graphiti**: Temporal knowledge graph (G = N, E, ϕ) with bi-temporal dimension. Three-tier subgraphs: episodes, semantic entities, communities. 94.8% DMR benchmark. Open-source at github.com/getzep/graphiti.
- **MemGPT (Letta)**: Hierarchical memory with episodic→semantic transformation. Handles multi-session cross-trial access. Production-proven on long-form conversational tasks.
- **LangChain Memory**: Multiple strategies including Knowledge Graph Memory and Entity Memory with cross-conversation context via thread-shared long-term memory.

**Verdict:** Strong prior art exists. This is not novel research territory — it is an engineering integration problem with well-understood patterns.

### Theoretical Grounding

The concept is well-grounded in cognitive science and AI architecture:

- **Episodic-to-Semantic Memory Consolidation** (Tulving, 1972; McClelland et al., 1995): The brain consolidates episodic memories into semantic knowledge during sleep/rest. Cross-session synthesis is the computational analog — periodic consolidation of session-specific insights into cross-cutting patterns.
- **Meta-Cognition** (Flavell, 1979): Thinking about thinking. Second-order reflection is a standard metacognitive process. The risk is computational confabulation, not theoretical unsoundness.
- **ACT-R Declarative Memory** (Anderson, 1993): Sylphie already uses ACT-R-inspired confidence dynamics. ACT-R's base-level activation decay naturally supports temporal windowing — insights accessed more recently have higher activation, making them natural candidates for synthesis.

The main theoretical concern is **confabulation compounding**: when LLMs reason about their own prior outputs, errors can propagate. Research shows that structured decomposition (breaking cross-session comparison into independent sub-questions) prevents drift better than unstructured chaining. Grounding synthesis in original text excerpts rather than re-generated summaries is critical.

### Technical Feasibility

**Current Architecture (Learning Subsystem):**
- `ConversationReflectionService` runs on a 5-minute timer (`REFLECTION_INTERVAL_MS = 300_000`), processing sessions quiet for 10+ minutes with 4+ events
- Uses LLM tier `medium` at temperature 0.3, maxTokens 1536
- Produces 6 insight types: DELAYED_REALIZATION, MISSED_CONNECTION, IMPLICIT_INSTRUCTION, CONTRADICTION, THEMATIC_THREAD, TONAL_SHIFT
- Creates INSIGHT nodes with `provenance_type: 'INFERENCE'` at confidence 0.30 (`REFLECTION_CONFIDENCE`)
- Marks reflected sessions in `reflected_sessions` TimescaleDB table
- `LearningService` manages timers with overlap guards (`reflectionInFlight` boolean)

**Integration Path:**
The existing architecture cleanly supports a new synthesis service parallel to `ConversationReflectionService`:

1. **New `CrossSessionSynthesisService`** — follows same pattern as reflection service
2. **New timer in `LearningService`** — `SYNTHESIS_INTERVAL_MS` (e.g., 1800s / 30 min), with `synthesisInFlight` guard
3. **Neo4j queries for insight pairs** — query INSIGHT nodes across sessions by type, entity overlap, or embedding similarity
4. **New edge types** — `SYNTHESIZES` (synthesis→source insight), plus `CONTRADICTS_INSIGHT`, `ELABORATES_INSIGHT`, `EVOLVES_FROM_INSIGHT`
5. **New TimescaleDB table** — `synthesized_insight_pairs` for tracking which insight combinations have been processed

**What Already Exists and Can Be Reused:**
- Timer/scheduler pattern with overlap guards ✓
- LLM integration with tier selection and availability checks ✓
- Neo4j node/edge creation patterns (MERGE, idempotent upserts) ✓
- Provenance tagging and confidence assignment ✓
- Lesion Test compatibility pattern (graceful degradation when LLM unavailable) ✓
- Fire-and-forget event logging ✓

**What Would Need to Be Built:**
- `CrossSessionSynthesisService` (new service, ~200-400 lines)
- Insight pair selection logic (Neo4j queries + optional embedding similarity)
- LLM prompt for cross-session reasoning
- New edge type definitions
- `synthesized_insight_pairs` TimescaleDB table
- Synthesis-specific LLM prompt template

## Assessment

| Dimension    | Rating   |
|-------------|----------|
| Plausibility | high     |
| Complexity   | moderate |
| Fit          | strong   |
| Risk         | medium   |

## Verdict

Cross-session insight synthesis is feasible and well-supported by prior art. The existing Learning subsystem architecture provides clean integration points — the new service would mirror `ConversationReflectionService` closely. The primary risks are CANON compliance (confidence dynamics for second-order inferences need explicit ruling) and confabulation compounding (mitigated by structured decomposition and grounding in original excerpts). Implementation should proceed after resolving the confidence lifecycle question with a CANON review.

## Implementation Path

### Phase 1: Foundation (3-5 days)

1. **CANON Pre-Approval** — Submit design for review focusing on:
   - Confidence dynamics for "inferences of inferences" (recommend: cap at 0.30, same as reflection, require GUARDIAN confirmation to exceed 0.60)
   - Whether synthesis provenance should be a new type (e.g., `SYNTHESIS`) or reuse `INFERENCE`
   - Whether synthesis adds new drive pressure or is timer-only

2. **Create `CrossSessionSynthesisService`** — parallel to `ConversationReflectionService`:
   - `findSynthesizablePairs()` → queries Neo4j for insight pairs (same entity references across different sessions)
   - `synthesizeInsightPair(insight1, insight2)` → calls LLM at `deep` tier
   - `persistSynthesisNode()` → creates new INSIGHT node with `SYNTHESIZES` edges to source insights
   - `ensureSchema()` → creates `synthesized_insight_pairs` table

3. **Add synthesis timer to `LearningService`** — `SYNTHESIS_INTERVAL_MS = 1_800_000` (30 min), with `synthesisInFlight` guard

4. **Define insight pair selection strategy:**
   - Primary: Entity overlap (insights that REVEALS the same entity across different sessions)
   - Secondary: Same insight_type across sessions (e.g., all CONTRADICTION insights)
   - Tertiary: Temporal windowing (last 10 sessions only, to avoid unbounded growth)

### Phase 2: Refinement (2-3 days)

5. **Add Neo4j indexes** on INSIGHT nodes: `insight_type`, `session_id`

6. **Implement confabulation guards:**
   - Include original insight descriptions (not re-generated summaries) in LLM context
   - Structured decomposition: ask LLM specific sub-questions rather than open-ended "what patterns do you see?"
   - Require LLM to cite specific insight IDs in its reasoning

7. **Add telemetry** — log synthesis token usage, insight pair counts, synthesis yield rate

### Phase 3: Production Hardening (2-3 days)

8. **Embedding-based similarity** for insight selection (if entity overlap alone is insufficient)
9. **Rate limiting** — cap synthesis to N pairs per cycle (e.g., 3) to control token budget
10. **Lesion Test verification** — confirm synthesis degrades gracefully when LLM unavailable
11. **GUARDIAN integration** — ensure synthesis insights appear in dashboard for confirmation/correction

### Open Design Decisions (Require Jim's Input)

- **Trigger cadence:** Timer-based (every 30 min) vs. threshold-based (after N new insights accumulate)? Recommend timer-based for simplicity.
- **New insight types:** Should synthesis produce new types like `CROSS_SESSION_CONTRADICTION`, `EVOLVING_PREFERENCE`, `RECURRING_THEME`? Or reuse existing types with a `synthesis: true` flag?
- **Confidence lifecycle:** Should repeated cross-session pattern detection count as "retrieval-and-use" under CANON §Immutable Standard 3? If a pattern appears in 5+ sessions, does confidence rise automatically, or only with GUARDIAN confirmation?

## Sources

- [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/pdf/2303.11366) — NeurIPS 2023
- [ExpeL: LLM Agents Are Experiential Learners](https://arxiv.org/html/2308.10144v2)
- [Meta-Reflection: A Feedback-Free Reflection Learning Framework](https://arxiv.org/abs/2412.13781) — ACL 2025
- [Reflective Memory Management for Long-term Conversational AI](https://arxiv.org/pdf/2503.08026)
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/pdf/2504.19413)
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956)
- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/pdf/2310.08560)
- [Teaching Language Models to Evolve with Users: Dynamic Profile Modeling](https://arxiv.org/html/2505.15456v1)
- [Mem-PAL: Memory-based Personalized Dialogue Assistants](https://arxiv.org/html/2511.13410v1)
- [MemoriesDB: A Temporal-Semantic-Relational Database for Long-Term Agent Memory](https://arxiv.org/abs/2511.06179)
- [Detecting hallucinations in large language models using semantic entropy](https://www.nature.com/articles/s41586-024-07421-0)
- Sylphie codebase: `packages/learning/src/conversation-reflection.service.ts`, `packages/learning/src/learning.service.ts`
