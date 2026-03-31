# Epic 5 Agent Analyses

This directory contains neuropsychological and systems analyses of **Epic 5: Decision Making (Core Cognitive Loop)** from specialized agent perspectives.

## Contents

### luria-analysis.md (855 lines)

**Purpose:** Neuropsychological validation of E5 against biological neuroscience and identification of engineering gaps from lesion studies.

**Key Sections:**

1. **Mapping to Luria's Three Functional Units** — How E5's components map to biological brain organization (prefrontal cortex, hippocampus, striatum, etc.)

2. **Episodic Memory System Validation** — Grounding in Systems Consolidation Theory; assessment of the fresh→recent→consolidated→archived degradation timeline

3. **Dual-Process Grounding** — Type 1/Type 2 arbitration validation against Kahneman's System 1/System 2 and basal ganglia/prefrontal competition; cost structure analysis

4. **Attention and Arousal Gating** — Posner's Three Attentional Networks applied to episodic memory encoding depth; specification of what should gate encoding gating (exogenous salience, endogenous goals, arousal level, prediction error)

5. **Prediction Error Neuroscience** — Schultz's dopaminergic prediction error mechanism and its instantiation in E5's predict-act-evaluate loop

6. **Temporal Dynamics** — Timescale alignment across Executor loop (~5Hz baseline), consolidation (hours-days), and Type 1 graduation (10-use window validation)

7. **Failure Modes from Lesion Studies** — Six critical E5 failure modes derived from neuropsychology:
   - Episodic memory system failure (medial temporal lobe amnesia analog)
   - Inner Monologue failure (vmPFC lesion analog)
   - Arbitration failure (anterior cingulate damage analog)
   - Executor Engine failure (dlPFC sequencing deficit analog)
   - Confidence Updater failure (striatal dopamine dysfunction analog)
   - Disconnection between subsystems (disconnection syndrome analog)

8. **Reconsolidation During Retrieval** — Retrieved-and-failed knowledge enters plastic state; recommendation for tagging and prioritization in Learning subsystem

9. **Working Memory Capacity Constraints** — Cowan's 4-item working memory limit applied to Inner Monologue; recommendation to cap candidate count

10. **Summary of Design Validation and Gaps** — Consolidated assessment table of:
    - Components with strong grounding (no changes needed)
    - Critical gaps requiring specification before implementation
    - Failure mode detection strategies for E10 integration testing

11. **Implementation Recommendations** — Specific guidance for:
    - Specification decisions before E5 code begins
    - Implementation patterns during E5
    - Testing and validation during E10

## Key Findings

### Design Strength: STRONG

E5 is **strongly grounded in neuroscience** with only minor specification gaps. The three core mechanisms are biologically sound:

1. **Episodic → Semantic consolidation** maps directly to hippocampal-cortical systems consolidation theory
2. **Prediction error learning** implements Schultz's dopaminergic mechanism with proper magnitude-proportional updates
3. **Type 1/Type 2 arbitration with graduated learning** mirrors basal ganglia/prefrontal competition

### Critical Specification Gaps (Before Implementation)

1. **Encoding Gating Mechanism** (CANON Gap A.2)
   - *Current state:* "gated by attention/arousal — not every tick is an episode"
   - *Missing:* Formula for computing encoding depth based on salience, arousal, prediction error
   - *Biological basis:* Locus coeruleus (norepinephrine) + anterior cingulate conflict detection
   - *Impact:* HIGH — affects what experiences are memorable vs. forgettable

2. **Type 1/Type 2 Dynamic Threshold Function** (CANON Gap A.3)
   - *Current state:* "dynamic threshold modulated by drive state (0.30-0.70)"
   - *Missing:* Exact formula mapping drive state to threshold
   - *Biological basis:* Different drives affect automaticity differently (high anxiety → more Type 1 but less flexible; high curiosity → more Type 2)
   - *Impact:* MEDIUM — affects adaptive behavior patterns

3. **Prediction Format and Error Computation**
   - *Current state:* "predictions are generated and evaluated" but format unspecified
   - *Missing:* What does a prediction contain? How is error computed? (MAE? MSE? cross-entropy?)
   - *Biological basis:* Dopaminergic prediction error (Schultz)
   - *Impact:* CRITICAL — affects learning signal and learning rate

### Failure Mode Detection (for E10 Integration Testing)

Each of six critical lesions has a specific diagnostic test:

| Lesion | Detection Test | Expected If Broken |
|--------|---|---|
| Episodic Memory | Repeat guardian statement; observe if system notices repetition | System cannot detect repetition; context-insensitive behavior |
| Inner Monologue | Novel situation requiring reasoning | System defaults to low-cost reflexes; no Type 2 reasoning |
| Arbitration | Guardian correction; observe if system updates | System perseverates on previous choice |
| Executor Engine | Multi-step action request | Executes only one step or all steps simultaneously |
| Confidence Updater | Measure confidence after 100 successful repetitions | Confidence remains unchanged (no learning) |
| Drive Disconnection | Measure correlation between action outcomes and drive changes | Zero correlation; system behavior unmotivated |

## Recommendations

### For E5 Design Phase (Before Code)

1. Coordinate with **Cortex** agent (CLAUDE.md references cortex.md as source for dynamic threshold specification)
2. Resolve CANON Appendix A.2 (Episodic Memory) and A.3 (Arbitration) with Jim's input
3. Define prediction format and error computation (consult with Drive Engine team)
4. Specify Executor loop tick rate (recommend: 5Hz baseline = 200ms per state)

### For E5 Implementation

1. Instrument Executor Engine state transitions for E9 dashboard visibility
2. Store `encoding_depth` values with episodes for later analysis and validation
3. Implement plasticity tagging: mark retrieved-and-failed edges for prioritized re-examination
4. Limit Inner Monologue candidates to ~4-5 (working memory constraint)
5. Track prediction calibration: is "60% confident" prediction actually ~60% accurate?

### For E10 Integration Testing

1. Run all six lesion tests to verify modular failure patterns
2. Validate learning curves: measure Type 1 graduation rates and confidence dynamics
3. Validate encoding gating: verify encoding depth correlates with drive pressure and prediction error
4. Validate decision quality: verify Type 1/Type 2 performance gap widens over time
5. Validate Lesion Test: run without LLM, observe degradation pattern

## References

- **CANON** (wiki/CANON.md) — Immutable project design
- **E5 Roadmap** (wiki/phase-1/roadmap.md, Section "Epic 5: Decision Making")
- **Luria Agent Profile** (.claude/agents/luria.md) — Neuropsychological Systems Advisor background
- **Cortex Agent Profile** (.claude/agents/cortex.md) — For arbitration algorithm specification

## Cross-References

This analysis is one of several E5 agent analyses. Expected agents and their contributions:

- **Luria** (this document) — Neuropsychological grounding, failure modes, biological plausibility
- **Cortex** — Arbitration algorithm specification, Type 1/Type 2 dynamics
- **Forge** — Implementation architecture, API design, integration patterns
- **Sentinel** — Observability, monitoring, diagnostic logging
- **Skinner** — Drive-behavior contingency mapping, behavioral patterns
- **Scout** — Curiosity-driven exploration, novel stimulus handling, information foraging

---

**Prepared:** March 29, 2026
**Status:** Ready for E5 Design and Implementation
**Next Review:** E5 Design Document (before code), then E10 Integration Testing
