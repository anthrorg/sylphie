---
description: Decompose epics into an atomic, traceable ticket list, then red-team it for holes. Delegates to plan-decomposer and plan-reviewer.
allowed-tools: Read, Edit, Bash, Task
---

# /plan-tickets

Produce the atomic backlog — the core output of planning-worx.

1. Read `planning/contract.yaml`. Confirm `/plan-design` is done.
2. **Delegate to the `plan-decomposer` subagent** (fresh context). For each `epic`,
   ask it to produce `ticket` nodes (ids `TK-1`…, `parent: <EP>`) that each pass the
   atomicity bar (use the `atomicity-gate` skill). Every ticket must have:
   - `intent` (who/what/why), `priority` (P1=MVP), `estimate`, `engineering_level`,
   - `acceptance_criteria` as testable Given/When/Then (≥1),
   - `non_goals` (per-ticket negative space), `complexity_budget`,
   - `depends_on` for real ordering, `files_in_scope` if known.
   Decompose to TICKET level only — do NOT pre-explode tickets into tasks (that is
   `/plan-ticket <id>`, done as-needed at build time).
3. **Iterate the atomicity pass — at least THREE passes, or until fixpoint.** After
   the first decomposition, re-read EVERY ticket and apply the `atomicity-gate` skill
   again, splitting any that fail via `story-splitter`. Then do it once more. Keep
   going until a full pass produces no new splits (fixpoint) — minimum three passes.
   Record the pass count in the changelog. The bar is genuinely atomic, not "small-ish".
4. **De-risk routing — apply the `poc-router` skill.** Scan every ticket for risk or
   ambiguity. For each that carries real feasibility risk or an unresolved unknown,
   route a POC AHEAD: create a `poc`-bearing node, sequence it early, and make the
   risky ticket + its dependents `depends_on` it. A POC must reach `poc.status: proven`
   before its dependents may start. (No POC for a known-doable ticket — that is theater.)
5. Write the tickets. Update `meta.stage: tickets`, `meta.updated_at`, changelog.
6. Run the coverage gate: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate_check.js" tickets`.
   It fails on any orphan ticket or any feature/epic with no tickets. Fix before continuing.
7. **Red-team the result: delegate to the `plan-reviewer` agent.** Record its
   CRITICAL/HIGH findings as governance `open_question`s or `risk`s. Surface them to
   the user. A clean backlog that nobody attacked is not yet trustworthy.

Then run `/plan-analyze` for the full cross-artifact audit, or start building with
`/plan-ticket <id>`.
