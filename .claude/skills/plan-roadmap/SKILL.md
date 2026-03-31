# Plan Roadmap

Produce a high-level roadmap for a project phase by convening strategic agents -- those who think about what to build and why, not how to code it.

## Usage

```
/plan-roadmap <phase>
/plan-roadmap 1            # Plan Phase 1 roadmap
/plan-roadmap 2            # Plan Phase 2 roadmap
```

## When to Use

- **Before** planning individual epics, to know what epics are needed
- When the project has a CANON but no clear path from "start" to "done"
- When existing epic plans feel like isolated components rather than a coherent system
- When confidence in the overall plan is low

## When NOT to Use

- For planning a single epic (use `/plan-epic`)
- For exploring a specific technical question (use `/explore-topic`)
- For implementation (use `/do-epic`)

## Prerequisites

1. `wiki/CANON.md` exists and defines the phase scope
2. Any existing epic plans in `docs/epics/` (the roadmap builds on what exists)

---

## Agents

Strategic agents only. Implementation agents (Forge, Sentinel, etc.) are NOT invited.

| Agent | Role in Roadmap | Model | Why |
|-------|----------------|-------|-----|
| **Ashby** | Systems architect | opus | Whole-system view. Subsystem interactions, feedback loops, emergent properties. |
| **Piaget** | Developmental sequencer | opus | Capability ordering, developmental prerequisites, progress milestones. |
| **Skinner** | Behavioral analyst | opus | What makes the system genuinely learn? What makes guardian interaction productive? |
| **Canon** | CANON enforcer | sonnet | Does the roadmap cover CANON requirements? Phase boundary enforcement. |
| **Cortex** | Integration planner | sonnet | How do pieces connect? What's the operational cycle? Integration risks. |

---

## Workflow (6 Phases)

### Phase 1: CONTEXT GATHERING

1. Read `wiki/CANON.md` -- extract phase definition, goals, constraints
2. Read existing epic plans in `docs/epics/`
3. Identify gaps between "what's planned" and "what CANON requires"

### Phase 2: STRATEGIC ANALYSIS (parallel)

Launch all 5 agents in parallel. Each answers:

> "What capabilities must exist for Phase N to be complete? What is missing?"

Each produces analysis in `docs/roadmap/phase-<N>/agent-analyses/`.

**Ashby:** Essential subsystems, feedback loops, emergent properties, integration boundaries
**Piaget:** Developmental sequence, capability prerequisites, milestone definitions
**Skinner:** Learning feedback loops, guardian interaction design, behavioral health metrics
**Canon:** Uncovered CANON requirements, phase boundary enforcement, drift risks
**Cortex:** Subsystem connections, operational cycle, integration gaps, vertical slices

### Phase 3: SYNTHESIS

Synthesize all 5 analyses into a unified roadmap:

1. **Capability Map** -- Every capability the phase needs, in plain language
2. **Epic Inventory** -- Complete list of epics (existing + new + integration)
3. **Dependency Map** -- Epic-level dependencies and critical path
4. **Vertical Slices** -- Real-world scenarios proving subsystems work together
5. **Risk Assessment** -- Technical, developmental, behavioral, CANON risks

### Phase 4: CANON VERIFICATION

Canon reviews: every CANON requirement covered, no phase boundary violations, milestones achievable.

### Phase 5: CONFIDENCE RATING

Rate each dimension HIGH / MEDIUM / LOW:
- Completeness, Ordering, Integration, Feasibility, CANON Alignment

### Phase 6: DECISION CAPTURE

Document gaps needing Jim's input, proposed CANON changes, open questions.

---

## Output Artifacts

```
docs/roadmap/phase-<N>/
├── roadmap.md              # The roadmap (primary output)
├── capability-map.md       # Capabilities with gap analysis
├── agent-analyses/         # Individual perspectives
├── confidence-rating.md    # Confidence scores
└── decisions.md            # Open questions for Jim
```

---

## Key Rules

- Describes **what** the system must do, not **how** it's coded
- Every capability in plain language
- Science agents run on opus
- Vertical slices are real-world scenarios, not unit tests
- The roadmap is a living document

---

## Skill Hierarchy

```
/plan-roadmap  →  produces epic inventory
/plan-epic     →  takes one epic, produces tickets
/do-epic       →  executes tickets
```

**Roadmap → Epics → Tickets → Implementation.**
