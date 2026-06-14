---
name: review-plan
description: Put an EXISTING proposed plan in front of the full team of specialist agents for adversarial review. Every relevant agent reads the plan and asks TWO rounds of questions about it — round 2 informed by the answers to round 1 — then it is synthesized into a verdict (proceed / proceed-with-changes / blocked) with the unresolved questions surfaced. The mirror of explore-topic: that skill PRODUCES thinking; this one STRESS-TESTS a plan that already exists. Use before committing to a build plan or any plan expensive to get wrong.
---

# Review Plan

Adversarial multi-agent review of a plan that **already exists** — a `wiki/ws*-build-plan.md`, an epic plan, a migration strategy, a design doc. This is the mirror of `explore-topic`: that skill produces thinking from an open question; this one takes a finished plan and lets the whole team try to find the flaw in it before a single line is built.

The engine is **questions, not verdicts**. Every relevant agent reads the plan and asks two rounds of questions about it. Round 1 surfaces each agent's domain concerns *as questions*. Those questions get answered (from the plan, the code, or by Jim). Round 2 is each agent re-reading the plan **plus the Round-1 answers** and asking the deeper follow-ups the answers provoke. Two rounds because a real review is a conversation — the second round catches what the first round's answers expose. It ends in a verdict the build either clears or doesn't.

## Usage

```
/review-plan wiki/ws5-build-plan.md
/review-plan                                          # reviews the plan currently proposed in this conversation
--agents atlas,drive,ashby,canon                      # Optional: specify participants (default = full relevant team)
--rounds 1                                            # Optional: question rounds (default 2)
```

## When to Use

- Before committing to a `wiki/ws*-build-plan.md` or any build-plan-sized change.
- When `mythos` (or anyone) has produced a plan and you want it adversarially checked before building — the cascade's "measure twice" step.
- When a plan spans subsystems and no single reviewer sees all the failure modes.
- When `/plan-epic` produced tickets and you want the team to pressure-test them before `/do-epic`.

## When NOT to Use

- A mechanical change with one obvious correct shape — just do it.
- A plan only one specialist owns — ask that specialist directly via the Agent tool; skip the fan-out.
- Producing a plan or exploring an open question from nothing — that's `plan-epic` / `explore-topic`.

## Prerequisites

1. A plan that already exists (a file, or the active in-conversation plan).
2. CANON loaded for grounding (`wiki/CANON.md` / the Six Immutable Standards in `sylphie-tech-spec.md §9`).

---

## Workflow (5 Phases)

### Phase 1: FRAME THE PLAN

1. Resolve the plan: read the file argument, or if empty, write the conversation's active plan to `wiki/reviews/<slug>/_plan-under-review.md` so agents have a stable file to read.
2. Read the plan yourself first. Extract: the thesis, the ticket/step list, the claimed provability story, the declared dependencies, the forks it already flags. You need this to answer Round-1 questions in Phase 3.
3. Select participants. If `--agents` not specified, auto-select the **full team whose lane the plan touches** (see Model Assignment). CANON **always** participates. **Exclude any agent that authored the plan** — it tie-breaks in Phase 4 instead of reviewing its own work.
4. Gather cheap pointers for the agents (they start fresh; most are read-only): the plan path, the governing docs it cites (`sylphie-tech-spec.md`, CANON, `sylphie-stub-inventory.md`), and the specific source files the plan names. Agents review faster and truer when handed the files instead of hunting.

### Phase 2: ROUND 1 — READ & QUESTION (parallel)

Each participating agent reads the plan and writes an opening review (in parallel). Each produces:
- **Questions** (the core deliverable): the things it must know to judge this plan that the plan does not answer. Specific — "what happens to X when Y?", not "is this safe?".
- **Concerns**: domain risks or failure modes the plan under-weights, each tied to a file/line or a Standard.
- **A provisional stance**: `proceed` / `proceed-with-changes` / `blocked`, one-line reason. Provisional — Round 2 may move it.

Each agent reviews through **its own lens only** — do not review outside the domain. Ground every point in the plan text or the code: "verified in `<file>`" vs "inferred". Saved to `opening-reviews/<agent>.md`.

**Model tiers:** science agents on `opus` (depth is the point); technical agents on `sonnet` unless the plan is primarily theoretical; Canon on `sonnet`.

### Phase 3: ANSWER ROUND 1, THEN ROUND 2 (the discussion)

Round 2 is only worth running if it builds on real answers, so answer first.

1. **Answer Round 1.** You (orchestrator) answer every question the plan or codebase already settles — read the cited files, quote the answer with its source. Batch the genuinely-open *decisions* (a fork the plan left open, a scope/priority tradeoff, anything expensive-to-get-wrong) and surface them to Jim with `AskUserQuestion` — never invent answers to decision-questions. Mark anything unanswerable-without-building as `OPEN — needs spike`. Record all Q→A in `discussion.yml`.
2. **Round 2 — follow-up (parallel).** Relaunch each agent with the plan **plus the Round-1 answers** (at least its own Q&A + any cross-cutting answers). Each produces:
   - **Follow-up questions** the answers now raise — the second-order issues. If an answer resolved a concern, say so; if it created a new one, ask it.
   - **Residual concerns** that survive the answers.
   - **Final stance**: `proceed` / `proceed-with-changes` (list the changes) / `blocked` (state the blocker). Binding for synthesis.
3. **Answer Round 2** the same way. Anything still open after this round is a genuine unknown — it goes in the verdict as a risk the build carries, not a thing to keep looping on. **Two rounds is the cap by default**; a third round is a signal the plan needs rework, not more review. (`--rounds 1` skips Round 2 and synthesizes on Round 1 + answers.)

Jim can participate in any round by adding to `discussion.yml` directly.

### Phase 4: SYNTHESIS & VERDICT

Orchestrator synthesizes the discussion into a verdict:
- **PROCEED** — no `blocked` stances; open items are spikes the build can absorb.
- **PROCEED-WITH-CHANGES** — list the concrete changes the team requires; the plan author edits the plan before build.
- **BLOCKED** — one or more `blocked` stances with a real blocker; name it and the owner who must resolve it.

Rules that override the tally:
- **CANON is load-bearing.** If `canon` returns `blocked`, the verdict is BLOCKED regardless of the vote — a Standards violation does not proceed on a majority.
- **Surface dissent, don't average it.** A lone `blocked` among `proceed`s is the headline, not a rounding error — it is exactly the domain-flaw this skill exists to catch. Quote it verbatim.
- **Collect every still-OPEN question** into an explicit risk register, each with the ticket/owner that must close it.
- If `mythos` did not participate (it authored the plan), use it here as a **tie-breaker / synthesis reviewer** on any unresolved tension between agents.

### Phase 5: CAPTURE

1. Save the synthesis and discussion as artifacts (below).
2. Relay the **verdict** and the **risk register** to Jim.
3. Flag any insight that should update CANON or that invalidates a *different* existing plan.
4. **Do not start the build off a BLOCKED or PROCEED-WITH-CHANGES verdict** until the changes land — that is the entire point of running the review.

---

## Output Artifacts

```
wiki/reviews/<plan-slug>/
├── verdict.md            # PROCEED / PROCEED-WITH-CHANGES / BLOCKED + required changes or named blocker, on top
├── synthesis.md          # full synthesis: stances, dissent, risk register
├── opening-reviews/      # each agent's Round-1 questions + concerns + provisional stance
│   ├── atlas.md
│   ├── drive.md
│   └── ...
├── discussion.yml        # threaded Q&A across both rounds (questions → answers → follow-ups)
└── _plan-under-review.md  # snapshot of the plan reviewed (only if it came from the conversation, not a file)
```

---

## Key Rules

- **Questions are the deliverable, not verdicts.** An agent that jumps to "looks good" has not done the job — push for the specific things it needs to know. The skill is named *review-plan*, but its engine is *questions about the plan*.
- **Round 2 must see Round 1's answers**, or it is not a second round — just a duplicate first. The answer step between is mandatory.
- **CANON always participates and can single-handedly block.** The Six Immutable Standards are not majority-votable.
- **Read-only.** No agent edits code or the plan during review. Changes are applied by the plan author *after* the verdict.
- **Ground everything.** "verified in `<file>`" vs "inferred" — an ungrounded concern is noise.
- **Don't have an agent review its own plan.** Author → Phase 4 tie-breaker, not Phase 2 reviewer.
- **Match ceremony to stakes.** This is one of the **most expensive** skills — two rounds × a full roster is many agent calls. For a small plan, scope the roster or drop to `--rounds 1`. For a `ws*-build-plan.md` that sets a workstream's direction, run it full.
- **Every review must produce a verdict.** Raw discussion without a proceed/blocked decision is waste.

---

## Model Assignment

| Agent Type | Model | Rationale |
|---|---|---|
| Science agents (Ashby, Skinner, Luria, Piaget, Scout) | opus | Deep reasoning is where they earn their cost |
| Technical agents (Atlas, Forge, Cortex, Drive, Learning, Planner, Vox, Meridian, Hopper, Sentinel) | sonnet | Unless the plan is primarily theoretical, then opus |
| Canon | sonnet | CANON / Six-Standards grounding checks |
| Proof | sonnet | Verifies the plan ends in a real, provable gate row |
| Mythos | opus | Whole-system read; tie-breaker if it authored the plan |
