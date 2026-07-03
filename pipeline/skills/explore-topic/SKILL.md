---
name: explore-topic
description: Open-ended multi-agent reconciliation on a research question, design decision, or novel approach. Science and technical agents debate across structured rounds — opening positions, challenge/revise, synthesis. Use when an approach is unclear, two specialists disagree, feasibility is unknown, or a problem genuinely benefits from multi-perspective analysis. The most expensive skill — reserve it for questions worth it.
---

# Explore Topic (sylphie)

Open-ended multi-agent discussion on a research question, design decision, or novel
approach. This is where the hardest thinking happens — science agents and technical
agents debating approaches, challenging assumptions, and reconciling positions across
rounds to discover things none of them would find alone. It is **reconciliation**, not
single-source research: the value is in the disagreement getting resolved.

## Usage

```
/explore-topic "<question>"
/explore-topic "How should drive isolation handle a cross-modal pressure spike?"
/explore-topic "Is the confidence ceiling of 0.60 right for taught procedures?"
--agents piaget,skinner,atlas        # Optional: specify participants
--rounds 5                            # Optional: max discussion rounds (default 3)
```

## When to use

- Before planning an epic/ticket when the **approach is unclear**.
- When two agents **disagree** during planning or review — escalate to a focused
  reconciliation instead of a coin-flip.
- When Jim has a **new idea** — explore feasibility and design before committing.
- When hitting an **implementation wall** — explore alternative approaches.
- From the pipeline: when the `plan` cog judges an item too novel/cross-cutting to
  plan, it routes to the `explore` cog, which runs this skill (see Pipeline below).

## Prerequisites

1. A question worth the cost (this is the most expensive skill in the repo).
2. Grounding loaded: the **Six Immutable Standards** in `CLAUDE.md` (drive isolation,
   provenance-required, confidence ceiling 0.60, theater prohibition, guardian
   asymmetry, no self-modification of evaluation), plus `sylphie-tech-spec.md` for the
   architecture. There is no standalone CANON.md — the `canon` agent holds the line.

---

## Workflow (5 phases)

### Phase 1 — Frame the question
1. `architect` (orchestrator) restates the topic as one specific, answerable question.
2. Identify which agents have relevant perspectives. If `--agents` is not given,
   auto-select by domain using the **work-trio path→owner map in `CLAUDE.md`** (the
   owner of the affected subsystem + its conceptual reviewer are always in).
3. Load grounding (Six Immutable Standards + the relevant tech-spec section).

### Phase 2 — Opening positions  (in parallel)
Each agent writes their initial take:
- What they think the answer is, from their domain.
- What concerns or risks they see.
- What questions they have for other agents.
- What they think the group is overlooking.

### Phase 3 — Discussion rounds  (default 3, max `--rounds`)
Structured rounds captured in `discussion.yml`:
- Each agent answers the questions directed at them.
- Each agent may challenge another's position, with reasons.
- Each agent may revise their position based on new input.
- `canon` flags any drift from the Six Immutable Standards immediately.
- A round ends when no new questions are raised; the discussion ends at consensus or
  at `--rounds`, whichever comes first.

### Phase 4 — Synthesis
`architect` synthesizes the discussion into:
- Points of agreement across agents.
- Unresolved disagreements, with each side's strongest argument.
- Novel ideas that emerged.
- A recommended approach (if consensus exists) — and if not, the crux that blocks it.
- Open questions for Jim.

When specialists are deadlocked, `architect` is the tie-breaker (its standing role).

### Phase 5 — Capture
1. Save the discussion and synthesis as artifacts (below).
2. Flag insights that should update CANON → hand to the `update-canon` skill.
3. Flag insights that affect the plan → write them into planning-worx as governance
   `open_question`s or `decision`s in `planning/contract.yaml` (append-only).

---

## Model assignment

| Agent type | Agents | Model | Rationale |
|---|---|---|---|
| Science (conceptual reviewers) | piaget, skinner, luria, ashby, scout | **opus** | Deep reasoning is the point — this is where they earn their cost. |
| Technical / domain experts | atlas, forge, cortex, drive, learning, planner, meridian, vox, sentinel, marr | sonnet | Bumped to **opus** when the topic is primarily theoretical. |
| Grounding | canon | sonnet | Guards the Six Immutable Standards. |
| Orchestrator / synthesis / tie-break | architect | opus | Frames, synthesizes, breaks deadlocks. |

---

## Output artifacts

```
docs/explorations/<topic-slug>/
├── synthesis.md          # Final synthesis (always produced)
├── opening-positions/     # Each agent's initial take
│   ├── piaget.md
│   ├── atlas.md
│   └── ...
├── discussion.yml        # Full threaded discussion across rounds
└── canon-implications.md # Proposed CANON / contract changes, if any
```

When invoked by the pipeline `explore` cog, write the same set into the item's folder
under `exploration/` instead, so the synthesis travels with the item back to planning.

---

## Pipeline integration (the `explore` cog)

The `plan` cog routes an item to `explore` when it needs genuine reconciliation, not
just codebase discovery — a novel approach, a cross-subsystem design question, or a
case where two specialists would clearly disagree. The `explore` cog runs this skill on
the item's framed question, drops `exploration/synthesis.md` into the item folder, then
moves the item back to `planning` so it is re-planned grounded in the reconciliation.
This is the most expensive cog: hard-bounded to one item per tick, low default rounds,
and opus only for the science seats.

---

## Key rules

- The **most expensive** skill — use it only for questions that genuinely benefit from
  multi-perspective reconciliation. A question one agent could answer is not one of them.
- Science agents **always** run on opus here.
- Rounds are **capped** to prevent infinite spiraling.
- Every exploration **must** end in a synthesis — raw discussion with no conclusion is
  waste.
- Jim can join any round by adding to `discussion.yml` directly.
- Grounding is non-negotiable: if the discussion drifts from the Six Immutable
  Standards, `canon` halts it until the conflict is surfaced.
