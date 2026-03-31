# Sylphie

AI companion that develops genuine personality through experience. Knowledge lives in the World Knowledge Graph. Behavior is drive-mediated and prediction-driven. The LLM is her voice, not her mind.

---

## Critical Constraints (read before every PR)

### Architectural Boundaries
- The **World Knowledge Graph (Neo4j)** is the brain. Everything writes to or reads from it.
- The **LLM (Claude API)** is Sylphie's voice -- it provides communicative competence. It does NOT make decisions. The graph, drives, and predictions drive behavior.
- **Drive computation runs in a separate process** with one-way communication. The system can READ drive values but cannot WRITE to the evaluation function.
- Drive rules in PostgreSQL are **write-protected from autonomous modification**. Only guardian-approved changes permitted.
- **Self KG and Other KG (Grafeo)** are completely isolated from each other and from the WKG. No shared edges, no cross-contamination.
- **TimescaleDB** is the event backbone -- all five subsystems write to it.
- **PostgreSQL** stores settings, users, drive rules, and meta -- things Sylphie should be unaware of.

### Type 1 / Type 2 Discipline
- Everything starts as **Type 2** (LLM-assisted). Behaviors graduate to **Type 1** (graph-based reflex) through successful repetition.
- **Type 2 must always carry explicit cost** -- latency, cognitive effort drive pressure, compute budget. Without cost, Type 1 never develops.
- Type 1 graduation requires: confidence > 0.80 AND prediction MAE < 0.10 over last 10 uses.

### Six Immutable Standards
1. **Theater Prohibition** -- Output must correlate with actual drive state. Directional: pressure expressions require drive > 0.2; relief expressions require drive < 0.3. No performing emotions she doesn't have, no claiming relief she hasn't earned.
2. **Contingency Requirement** -- Every positive reinforcement traces to a specific behavior.
3. **Confidence Ceiling** -- No knowledge exceeds 0.60 without successful retrieval-and-use.
4. **Shrug Imperative** -- When nothing is above threshold, signal incomprehension. No random low-confidence actions.
5. **Guardian Asymmetry** -- Guardian feedback outweighs algorithmic evaluation (2x confirm, 3x correction).
6. **No Self-Modification of Evaluation** -- Sylphie cannot modify how success is measured.

### Provenance
- Every node and edge carries provenance: `SENSOR`, `GUARDIAN`, `LLM_GENERATED`, `INFERENCE`
- This distinction is never erased. It enables the Lesion Test.
- `LLM_GENERATED` base confidence is 0.35 (lower than GUARDIAN at 0.60).

---

## Authoritative Documents

| Document | Location | Purpose |
|----------|----------|---------|
| CANON (single source of truth) | `wiki/CANON.md` | Immutable project design. All work validated against this. |
| Architecture Diagram | `wiki/sylphie2.png` | Visual overview of all five subsystems and data flow. |
| Agent Profiles | `.claude/agents/*.md` | Full agent profiles for sub-agent spawning |

---

## Architecture

Five subsystems communicating through two shared stores (TimescaleDB for events, WKG for knowledge).

| Subsystem | Role |
|-----------|------|
| Decision Making | Central cognitive loop. Dual-process (Type 1/Type 2), episodic memory, predictions, action selection. |
| Communication | Input parsing, person modeling, response generation via LLM, TTS/chatbox output. |
| Learning | Converts experience into durable knowledge. Maintenance cycles, entity extraction, edge refinement. |
| Drive Engine | Computes motivational state (12 drives), evaluates actions, detects opportunities. Runs in isolated process. |
| Planning | Triggered by opportunities. Researches patterns, simulates outcomes, proposes plans validated by LLM. |

### Five Databases

| Database | Technology | Purpose |
|----------|-----------|---------|
| World Knowledge Graph | Neo4j | "The what" -- world knowledge, entities, relationships |
| TimescaleDB | TimescaleDB | "The when" -- event backbone for all subsystems |
| Self Knowledge Graph | Grafeo | KG(Self) -- Sylphie's self-model |
| Other Knowledge Graph | Grafeo (one per person) | Models of other people (Person_Jim, etc.) |
| System DB | PostgreSQL | Drive rules, settings, users, meta -- things Sylphie is unaware of |

### 12 Drives (4 core + 8 complement)

| Category | Drive |
|----------|-------|
| Core | System Health, Moral Valence, Integrity, Cognitive Awareness |
| Complement | Guilt, Curiosity, Boredom, Anxiety, Satisfaction, Sadness, Information Integrity, Social |

### Confidence Dynamics (ACT-R)

`min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))`

- SENSOR base: 0.40
- GUARDIAN base: 0.60
- LLM_GENERATED base: 0.35
- INFERENCE base: 0.30
- Retrieval threshold: 0.50
- Type 1 graduation: confidence > 0.80 AND MAE < 0.10 over last 10 uses

---

## Tech Stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| Backend | NestJS (TypeScript) | Primary application server |
| Frontend | React + TypeScript + MUI | Dashboard, graph viz, conversation |
| Knowledge Graph | Neo4j Community Edition | World Knowledge Graph |
| Self/Other KGs | Grafeo | Embedded graph DB with Cypher support |
| Event Store | TimescaleDB | Central event backbone |
| System DB | PostgreSQL | Drive rules, settings, meta |
| Voice (STT) | OpenAI Whisper API | Perception layer |
| Voice (TTS) | OpenAI TTS API | Communication output |
| LLM | Anthropic Claude API | Type 2 deliberation, Learning refinement, Communication voice |
| Graph Viz | Cytoscape.js | Interactive knowledge graph visualization |
| Hardware | Robot chassis (Phase 3) | Physical exploration platform |

---

## Project Structure

```
sylphie/
├── .claude/
│   ├── agents/            # Agent profiles for sub-agent spawning
│   ├── hooks/             # Pre/post hooks for enforcement
│   ├── skills/            # Slash command skills
│   ├── settings.json      # Hooks and permissions
│   └── settings.local.json
├── wiki/
│   ├── CANON.md           # Immutable project design document
│   └── sylphie2.png       # Architecture diagram
├── src/                   # NestJS backend (TypeScript)
│   ├── decision-making/   # Subsystem 1: cognitive loop, Type 1/2 arbitration
│   ├── communication/     # Subsystem 2: input parsing, LLM voice, TTS/chatbox
│   ├── learning/          # Subsystem 3: consolidation, entity extraction, edge refinement
│   ├── drive-engine/      # Subsystem 4: 12 drives, self-evaluation, opportunity detection
│   ├── planning/          # Subsystem 5: opportunity research, simulations, plan creation
│   ├── knowledge/         # WKG interface, Neo4j queries, Grafeo KGs
│   ├── events/            # TimescaleDB event backbone
│   ├── shared/            # Types, utilities, configuration
│   └── app.module.ts      # Root NestJS module
├── frontend/              # React + TypeScript + MUI
│   └── src/
│       ├── components/    # UI components
│       ├── hooks/         # React hooks
│       ├── store/         # State management
│       └── types/         # TypeScript types
├── docs/
│   ├── architecture/      # Living architecture docs
│   ├── sessions/          # Post-implementation session logs
│   ├── epics/             # Epic planning documents
│   ├── decisions/         # Technical decision records
│   └── explorations/      # Multi-agent exploration topics
├── CLAUDE.md              # This file
└── README.md
```

---

## Current State

### Phase Progression

| Phase | Name | Status | Description |
|-------|------|--------|-------------|
| 1 | The Complete System | **ACTIVE** | All five subsystems: Decision Making, Communication, Learning, Drive Engine, Planning |
| 2 | The Body | FUTURE | Physical robot chassis, perception, embodied experience |

### Phase 1 Must Prove
- The prediction-evaluation loop produces genuine learning
- The Type 1/Type 2 ratio shifts over time
- The graph grows in ways that reflect real understanding, not just LLM regurgitation
- Personality emerges from contingencies
- The Planning subsystem creates useful procedures
- Drive dynamics produce recognizable behavioral patterns

---

## Rules (from CANON)

1. No code without epic-level planning validated against the CANON
2. Every epic is planned by parallel agents who cross-examine each other
3. The CANON is immutable unless Jim explicitly approves a change
4. Every implementation session produces a tangible artifact
5. Context preservation at end of every session

---

## Documentation Rules

### Session Logs

After every implementation session that modifies `src/`, write a session log:

**Location:** `docs/sessions/YYYY-MM-DD-{slug}.md`
**Max length:** 20 lines
**Template:**
```
# YYYY-MM-DD -- {What you did}

## Changes
- NEW/MODIFIED/DELETED: {file} -- {what and why}

## Wiring Changes
- {Any new connections between components}

## Known Issues
- {What's broken or incomplete}

## Gotchas for Next Session
- {What might bite the next person}
```

### When You Must Update Docs

| Trigger | Action |
|---------|--------|
| Added/removed .ts files in a module | Update that module's README or manifest |
| Changed `src/` files | Write session log in `docs/sessions/` |
| Debugged an error for >5 min | Add to `docs/architecture/error-playbook.md` |

---

## Verification

**How to verify changes:**
1. Sub-agents write code and return to the top-level agent
2. Top-level agent starts the app (`npm run start:dev`)
3. Top-level agent uses Playwright MCP to verify UI at `http://localhost:3000`
4. Check Neo4j at `http://localhost:7474` for graph/DB verification
5. Check browser console for errors
6. Type-check: `npx tsc --noEmit` from repo root

---

## Key Technical Patterns

### Drive Isolation
- Drive computation logic runs in a **separate process**
- One-way communication channel -- system reads, never writes
- Drive rules in Postgres are write-protected from autonomous modification
- System can PROPOSE new rules, but they enter a review queue
- This prevents the system from optimizing its own reward signal

### Behavioral Contingency Structure
- **Satisfaction habituation curve**: Diminishing returns on repeated success (+0.20, +0.15, +0.10, +0.05, +0.02)
- **Anxiety amplification**: Actions under high anxiety (>0.7) with negative outcomes get 1.5x confidence reduction
- **Guilt repair**: Requires BOTH acknowledgment AND behavioral change for full relief
- **Social comment quality**: Guardian response within 30s = extra reinforcement
- **Curiosity information gain**: Relief proportional to actual new knowledge gained

### Known Attractor States (prevent these)
- **Type 2 Addict**: LLM always wins, Type 1 never develops
- **Rule Drift**: Self-generated drive rules diverge from design intent
- **Hallucinated Knowledge**: LLM generates plausible but false graph content
- **Depressive Attractor**: Negative self-evaluations create feedback loop
- **Planning Runaway**: Too many prediction failures create resource exhaustion
- **Prediction Pessimist**: Early failures flood system with low-quality procedures

---

## Reference

- **CANON:** `wiki/CANON.md` -- read this before any architectural decision
- **Architecture diagram:** `wiki/sylphie2.png` -- visual subsystem map
- **Agent profiles:** `.claude/agents/` -- specialist agents for delegation
- **Design decisions:** `docs/decisions/` -- documented technical choices
