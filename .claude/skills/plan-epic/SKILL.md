# Plan Epic

Orchestrate specialist agents to collaboratively plan an epic, producing a ticket breakdown with dependencies, acceptance criteria, and agent assignments.

## Usage

```
/plan-epic <N>
/plan-epic 1        # Plan Epic 1
/plan-epic 1.3      # Plan Phase 1, Epic 3
```

## When to Use

- When starting a new epic that needs cross-agent planning
- When an epic scope is defined in the CANON or discussed with Jim
- Before any implementation work begins

## Prerequisites

1. `wiki/CANON.md` exists and is current
2. Epic scope is defined (in CANON or discussed with Jim)
3. Agent profiles loaded from `.claude/agents/*.md`

## v1 Codebase Discovery

This is a lift-and-shift from the `co-being` repo. Use the `codebase-pkg` MCP tools to discover existing v1 code that can inform interface design and implementation:

- `mcp__codebase-pkg__getModuleContext(query)` -- find related functions, types, files by concept (e.g., "drive engine", "executor loop", "confidence")
- `mcp__codebase-pkg__searchContent(pattern)` -- grep v1 function/type bodies for specific patterns
- `mcp__codebase-pkg__getFunctionDetail(name)` -- get the full body of a specific v1 function
- `mcp__codebase-pkg__getDataFlow(query)` -- trace data flow through v1 modules

Agents should use these tools during Phase 3 analysis to identify v1 code that can be lifted, adapted, or referenced for interface shapes. This prevents reinventing patterns that already exist in the v1 codebase.

---

## Workflow (7 Phases)

### Phase 1: SCOPE DEFINITION

1. Read `wiki/CANON.md`, extract the epic's scope and constraints
2. Identify which CANON principles are relevant
3. Determine phase boundaries -- do NOT pull in future phase work

### Phase 2: AGENT SELECTION

Determine participating agents based on epic scope:
- **Science agents** (Piaget, Skinner, Luria, Ashby): `opus` for deep analysis
- **Technical agents** (Atlas, Forge, Cortex, Vox, etc.): `sonnet` for implementation focus
- **Canon**: always participates, `sonnet` for routine checks

### Phase 3: PARALLEL ANALYSIS

Launch each assigned agent in parallel to analyze the epic:
- Technical agents: feasibility, approach, risks, dependencies
- Science agents: theoretical grounding, known pitfalls, design guidance
- Canon: CANON alignment check

Each agent produces an analysis saved to `wiki/phase-1/epic-<N>/agent-analyses/`.

### Phase 4: DISCUSSION PHASE

Agents cross-examine each other:
- Science agents challenge technical approaches
- Technical agents push back on theoretical ideals with practical constraints
- Canon flags any drift from CANON principles
- **Max 3 discussion rounds**

### Phase 5: TICKET SYNTHESIS

Consolidate into `tickets.yml`:

```yaml
epic: 1
title: "Epic Title"
phase: 1
created: 2026-03-28
status: planned

tickets:
  - id: T001
    meta:
      title: "Ticket title"
      description: |
        What needs to be built and why.
      acceptance_criteria:
        - "Specific, testable criterion"
    agents: [atlas]
    model: sonnet
    dependencies: []
    complexity: M
```

### Phase 6: CANON VERIFICATION

Canon agent reviews the final ticket list against CANON principles.

### Phase 7: DECISION CAPTURE

Document decisions made during planning. Flag proposed CANON changes for Jim.

---

## Output Artifacts

```
wiki/phase-1/epic-<N>/
├── tickets.yml           # Structured ticket list (consumed by /do-epic)
├── epic-plan.md          # Human-readable summary
├── agent-analyses/       # Individual agent perspectives
├── discussion.yml        # Cross-agent Q&A
├── canon-verification.md # CANON alignment report
└── decisions.md          # Decisions needing CANON update
```

---

## Key Rules

- Canon participates in EVERY epic plan
- Science agents run on opus for analysis
- Technical agents run on sonnet
- Acceptance criteria must be specific and testable
- Tickets must be small enough to complete in a single session
