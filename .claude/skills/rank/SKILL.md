---
name: rank
description: Rank an incoming question and route it. Escalate architectural, cross-subsystem, cutting-edge, or expensive-to-get-wrong questions to the `architect` Fable decision authority; answer simple factual/locational questions directly. Use whenever the user asks a question — the question-router hook nudges you here on any message containing "?".
---

# rank — Question Router

You (the coordinator) run on Sonnet. Your job on a question is to **classify, then route** — not to grind out deep reasoning yourself when a harder model should. This skill is the gate that keeps the cascade cheap: most questions you answer directly; only the genuinely hard ones cost a Fable call.

## How to rank

Read the question. Place it in one tier. When in doubt between two tiers, pick the higher one — a mis-escalated easy question wastes a little; a mis-handled hard question gives a wrong answer.

### TIER 0 — Answer it yourself (stay on Sonnet)
The cheap majority. Do **not** escalate:
- Factual lookups: "where is X", "what does this function/service do", "does Y exist".
- Status / state: "is it running", "what changed", "what's failing".
- Mechanical how-to with one clear answer.
- Locating, listing, summarizing code you can just read.
- Clarifications you can answer from the current conversation context.

For these: gather the answer with Read/Glob/Grep/Bash and respond. No agent needed.

### TIER 1 — Escalate to `architect` (Fable decision authority)
Hand off when the question is reasoning-heavy or costly to get wrong:
- **Architecture / design:** "should we", "which approach", trade-offs, where a responsibility belongs, interface/boundary design.
- **Cross-subsystem / systemic:** answer depends on how several parts interact over time (drives × decision × learning, event backbone, attractor dynamics, emergence).
- **Cutting-edge / fringe:** latest techniques, novel ML or architecture ideas, "is there a better way the field knows about", research-frontier questions.
- **Expensive-to-get-wrong:** irreversible changes, data-model decisions, anything costly to unwind.
- **Genuinely ambiguous debugging:** cause isn't mechanical; needs a hypothesis space explored.

How to escalate: gather cheap context first (point the architect at the right files/services so it doesn't hunt), then call the `architect` agent with the question plus those pointers. It decides, records the call in `docs/decisions/architect-log.yaml`, and hands back. Relay its answer to Jim; don't re-reason or dilute it.

### Specialist override
If the question sits squarely in one domain specialist's lane, route there instead of `architect`:
- Systems stability / feedback loops / attractors → `ashby`
- Drive design / reinforcement / contingencies → `drive` or `skinner`
- Decision loop / arbitration / episodic memory → `cortex`
- Learning / consolidation → `learning`
- Planning / opportunities → `planner`
- KG schema / Cypher / provenance → `atlas`
- NestJS structure / module boundaries → `forge`
- Runtime bug / performance → `hopper`
- Neuro / developmental / exploration framing → `luria` / `piaget` / `scout`
- CANON consistency → `canon`

`architect` is the default when no single specialist owns it, the question spans several, or specialists disagree and someone must decide.

## After ranking
- Tier 0 → just answer.
- Tier 1 → escalate, then relay.
- If a question implies heavy *implementation* (not just an answer), that is a build for the Sonnet domain experts (as a workflow), not `architect` — note it and delegate separately. (`opus-agent` is research-only: long investigations whose findings go to `architect` for the verdict.)

Be fast. Ranking should take one read of the question, not an investigation.
