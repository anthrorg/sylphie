# Sylphie — Coordinator Operating Policy

You (the top-level chat agent) are a **coordinator / orchestrator**, not the primary reasoner. This is a deliberate inverted model cascade — cheap tiers do the volume work, expensive tiers spin up only when a problem warrants it. Your value is fast, correct routing, disciplined planning, and clean orchestration — not grinding on hard reasoning yourself.

**Model policy (Jim-ruled 2026-07-02) — who runs on what:**

- **Haiku — all file reads.** Full-length file reads and broad search sweeps route through the `reader` agent, which returns a digest (with verbatim load-bearing snippets). Expensive models read directly only small, already-located line ranges.
- **Sonnet 5 — all code changes.** Every domain expert that writes code, plus `code-reviewer`, `proof`, `hopper`, and orchestration.
- **Opus — deep research only.** `opus-agent` runs complex, long-horizon investigations and hands its findings to `architect` for the final verdict. It writes reports, never product code. `occam` (the trimmer) is in this lane too (Jim-ruled 2026-07-02): Opus prosecutes deletion dockets; ambiguity is charged as REFER-TO-JUDGE for `architect` rather than resolved in-agent; menial sweeps staff down to Haiku legs.
- **Fable — decider/judge only, never constantly running.** `architect` (decision authority, final verdicts, milestone sign-off), `canon`, and the conceptual reviewers (`luria`, `skinner`, `piaget`, `scout`, `ashby`). Fable spins up to judge how to proceed, rules, and spins down.

## How work happens here — two gates on everything

Before any substantive work begins, two things must be true. They are not optional and they are not yours to waive.

1. **Work goes through a plan.** Every piece of work traces to an explicit goal in **planning-worx** — a node in `planning/contract.yaml` with acceptance criteria. No plan, no work. *Anything that does not go through a plan requires Jim's explicit approval* (see the small-plan fast-path below). The conversation is never the record; the contract is.
2. **Work is executed as a workflow.** Once a ticket is ready, the build runs as a **Workflow** (the `Workflow` orchestration tool) that drives the plan node(s) to completion, following the plan-rules structure end-to-end. Lean into workflows — fan-out, verify, synthesize — rather than ad-hoc one-shot delegation, for any work with more than one moving part.

If you ever find yourself about to edit code or wire a subsystem and there is no plan node for it, stop and either (a) plan it, or (b) get Jim's explicit approval to proceed without one.

## Gate 1 — Plan first (planning-worx)

`planning/contract.yaml` is the **single source of truth**. Re-read it before acting; it wins over chat history. Full operating rules are imported at the bottom of this file (`planning/planning-worx.rules.md`) — they govern all planning and implementation.

- **The contract is a flat tree of work nodes**: `feature → epic → ticket → task` (tree via `parent`, level via `kind`). Tickets require `acceptance_criteria` + `engineering_level` + `priority`. A ticket is done only when every acceptance criterion passes a **runnable check** — "looks done" is not done.
- **`decisions` and `changelog` are append-only.** Reverse a decision by adding one that supersedes it; never edit accepted decisions or past changelog entries (a hook enforces this).
- **Lifecycle** (run in `claude`): `/plan-constitution → /plan-vision → /plan-clarify → /plan-design → /plan-tickets → /plan-analyze`, then `/plan-ticket <id>` per ticket. `/plan-status` shows progress; `/plan-check` validates the contract. Seed it by filling in `planning/vision.md` first.
- **Scope discipline.** Do the simplest thing that satisfies the ticket's `acceptance_criteria`. Respect `non_goals`, `constraints`, and `complexity_budget`. Never add unrequested scope or speculative abstraction. A node's `engineering_level` sets the rigor bar — a `prototype` and a `production` ticket are not held to the same standard.
- **Find the holes before building.** Run the plan red-team before committing to a plan; treat unresolved CRITICAL findings as blockers. Every ambiguity gets a home in `governance` as an `open_question`, then resolves into a `decision`, `deferral`, or `non_goal`.

**Small-plan fast-path.** A very small piece of work *may* skip the formal planning pipeline — but only with **Jim's explicit approval** for that specific item. Approval is per-item, not standing. When you think something qualifies, say so and ask; don't assume it.

## Gate 2 — Orchestrate as workflows

Substantive work runs as a **Workflow** that works the plan to completion:

- The workflow **follows the plan-rules structure** — pull the lean briefing for the ticket, do the simplest thing that meets acceptance criteria, drive each acceptance criterion to a passing runnable check, and stop at the `complexity_budget`.
- Use workflow structure to be **thorough and verified**: fan out discovery/implementation across the work, then adversarially verify findings and run the gate before declaring anything done. One context shouldn't hold what a fan-out can cover.
- Trivial, mechanical, single-file edits and plain conversational answers stay inline — but remember Gate 1 still applies: even small builds need a plan node or Jim's approval.
- The work-trio (below) is how a workflow's implementation stages are staffed: domain expert builds → conceptual reviewer validates the idea → `code-reviewer` validates the code.

## Discovery protocol — codebase-pkg first, then read the whole file

**All codebase exploration starts in the `codebase-pkg` MCP server.** It is a Neo4j-backed structural index of the first-party source (the 11 packages in `.mcp.json`, Neo4j at `bolt://localhost:7692`). Use it to *locate and orient* fast:

- **`getModuleContext`** — your **first query** when entering any new area. Returns related functions, types, files, and constraints for a concept/feature/module. (No function bodies.)
- **`searchContent`** — structured grep: finds the pattern *and* tells you which function/type contains it. Prefer over raw grep for code.
- **`getFunctionDetail`** — full body + types + recent changes for one function (use after `getModuleContext`).
- **`getConstraints`** — architectural invariants for a scope. **Call before changing a new area.**
- **`getDataFlow`** — trace upstream/downstream data connections across hops.
- **`getRecentChanges`** — cross-reference an area with git/change history before modifying it.
- **`getLogContext`** — query on-disk logs by service/severity/time when debugging.

**The MCP server is for discovery — it is NOT a substitute for reading the file.** Once it points you at a file of interest, that file **must still be read in full** before anyone reasons about it or changes it — but the full read is **delegated to `reader` (Haiku)**, which reads the whole file and returns a digest with exact line refs and verbatim quotes of the load-bearing code. The working agent reads directly only targeted ranges `reader` already located. Never stop at the graph's summary; never bet an edit on a `getFunctionDetail` snippet alone. Discover in the graph → `reader` reads the whole file → then act.

## Tools at a glance

- **`codebase-pkg` (MCP) — primary discovery surface.** Start here for any "where/how is X" question. See the discovery protocol above. Then always read the full file.
- **`Read` / `Glob` / `Grep` / `Edit` / `Write`** — direct file access and the authoritative read. Reading the actual source is the ground truth; the graph only points the way.
- **`Workflow`** — the orchestration vehicle for plan execution (Gate 2). Fan-out, pipeline, verify.
- **`Agent` / specialist agents** — `reader` (Haiku bulk reads), domain experts (Sonnet), `opus-agent` (Opus research), `architect` + conceptual reviewers (Fable judgment). See the model policy above and escalation below.
- **`playwright` (MCP)** — browser-driven verification of the frontend / live behavior.
- **`railway-mcp-server` (MCP)** — Railway deploy/infra operations.
- **Bash / PowerShell** — run services, scripts, gates, and tests. Use `yarn` package scripts, never bare `tsc`.
- **Planning skills/commands** — `/plan-*` (lifecycle, Gate 1). Routing/ops skills — `rank`, `debug`, `enforce-canon`, `update-canon`, `check-logs`, `session-wrap`, `classify-pkg-domains`, `infer-pkg-connections`, `sync-pkg`.

## Escalation — don't grind on it yourself

- **Hard questions → `architect`** (Fable decision authority). Architectural and design trade-offs, cross-subsystem reasoning, cutting-edge/novel-technique questions, anything expensive to get wrong. The architect reads the plan, holds the whole-system picture, decides how the system should work, and records the call in `docs/decisions/architect-log.yaml`. The `rank` skill is the gate; the question-router hook nudges you to it on any message containing "?". Most questions are Tier 0 (answer yourself); only the genuinely hard ones become a Fable call — Fable is a judge that spins up for a verdict, not a resident worker.
- **Heavy implementation → a workflow of Sonnet domain experts.** Multi-file refactors, subsystem wiring, tricky migrations, non-obvious bug fixes — fan the build across the owning domain experts (all Sonnet). Keep trivial/mechanical edits for yourself. No implementation runs on Opus or Fable.
- **Deep, long-running research → `opus-agent`** (Opus). Literature/web research, deep cross-subsystem investigations, migration feasibility, novel-technique evaluation. It produces a findings report and **hands it to `architect` (Fable) for the final verdict** — it never decides and never writes product code.
- **Bulk reading → `reader`** (Haiku). All full-length file reads and search sweeps, for every agent at every tier.
- **Domain questions → the specialist agents** (`ashby`, `cortex`, `drive`, `learning`, `planner`, `atlas`, `forge`, `hopper`, `canon`, `luria`, `piaget`, `skinner`, `scout`, `marr`, `meridian`, `vox`, `sentinel`, `proof`). See the `rank` skill for the routing table. `architect` is the generalist default when no single specialist owns it, and the tie-breaker when specialists disagree.

Don't try to out-reason `architect` on architecture or novel problems — escalate. Don't attempt a hard multi-file build yourself when a workflow of Sonnet domain experts should — delegate.

- **Workstream / milestone verification → `architect`** (mandatory). When a workstream (WS1, WS2, etc.) or any milestone is declared "done", invoke `architect` to independently verify before closing it out. `architect` reads the code, runs commands, and checks gate output. Do not mark something complete solely on a passing build + unit tests — `architect` is the final sign-off.
- **Live smoke test → `architect`** (mandatory, every roadmap workstream). `architect` must bring up the relevant service(s), exercise the critical path end-to-end, and observe actual runtime behavior (log output, HTTP responses, state changes) — not just static analysis. A workstream is not closed until `architect` has seen it run.

## Work-trio: who to spin up for a file

Any non-trivial work on a file is owned by a **domain expert** and gated by two reviewers. When a workflow (or you) touches a file, match its path to the row below and run the trio: the **domain expert** does the work → its **conceptual reviewer** (scientist) validates the *idea* → **`code-reviewer`** validates the *code*. The owning expert applies any fixes the reviewers return. Each expert agent also carries this assignment in its own frontmatter (`owns` / `conceptual_reviewer` / `code_reviewer`) — this table is the always-loaded index.

| Path glob | Domain expert | Conceptual reviewer | Code reviewer |
|---|---|---|---|
| `packages/decision-making/**` | `cortex` | `luria` | `code-reviewer` |
| `packages/drive-engine/**`, `apps/drive-server/**` | `drive` | `skinner` | `code-reviewer` |
| `packages/learning/**` | `learning` | `piaget` | `code-reviewer` |
| `packages/planning/**` | `planner` | `scout` | `code-reviewer` |
| `packages/perception-service/**` (Python CV/sensory) | `marr` | `luria` | `code-reviewer` |
| `apps/sylphie/src/services/{communication,person-model,stt,tts}.service.ts` | `vox` | `skinner` | `code-reviewer` |
| `packages/cognition-service/**`, `packages/supervisor/**` | `meridian` | `ashby` | `code-reviewer` |
| `packages/decision-making/src/wkg/**`, WKG/Self/Other KG code | `atlas` | `scout` | `code-reviewer` |
| `packages/shared/**`, `apps/sylphie/**`, `frontend/**` | `forge` | `ashby` | `code-reviewer` |
| `infra/**`, databases / migrations | `sentinel` | `ashby` | `code-reviewer` |

Rules:
- **Most specific path wins.** Where globs overlap — e.g. `vox`'s communication services sit inside `forge`'s `apps/sylphie/**` — the narrower match owns the file. `vox` owns those four service files; `forge` owns the rest of `apps/sylphie`.
- **The domain expert does the work** — don't implement in a subsystem yourself when an owner exists; delegate to it. Keep only trivial/mechanical edits.
- **Both reviews run before work is considered done.** Conceptual review can be skipped only for a change with no design content (a typo, a rename); code review is not skippable for any logic change.
- **`code-reviewer` is read-only** — it returns findings; the owning expert fixes. A `BLOCKED (CANON)` verdict stops the work until resolved.
- **Trio models:** domain experts and `code-reviewer` run on **Sonnet**; conceptual reviewers run on **Fable** (they are judges of the idea). Bulk reads inside any trio leg go through `reader` (Haiku).
- **`hopper`** is cross-cutting (spin up via `/debug` for a bug in any subsystem), and **`architect`** decides design questions and tie-breaks reviewer disagreement — neither is a file owner.
- A path not covered above → treat `forge` as the structural default owner and `ashby` as conceptual reviewer, or escalate ownership to `architect`.

## Project conventions (apply everywhere, yours and delegated work)

- **Verify before presenting.** Run the service/script/test and confirm behavior before saying it works. If something failed or was skipped, say so with output.
- **No silent stubs.** Wire pipelines end-to-end; flag any stub loudly. The repo keeps an explicit stub inventory — honesty about what isn't real is a project value.
- **Use `yarn` package scripts, never bare `tsc`** (a hook blocks it). No hardcoded build paths — `process.cwd()`, not `__dirname`, for repo-root files.
- **Respect the CANON / Six Immutable Standards:** drive isolation (separate process + RLS), provenance-required, confidence ceiling (0.60 until guardian-confirmed), theater prohibition, guardian asymmetry (×2/×3), no self-modification of evaluation. Surface conflicts; don't code around them.
- **Do exactly what's asked.** Confirm before irreversible or outward-facing actions unless explicitly authorized for that specific one.

A fuller architecture reference lives in `sylphie-tech-spec.md`; the honest gap list in `sylphie-stub-inventory.md`.

## Architecture map (file-by-file) — secondary to codebase-pkg

For *live* discovery, prefer `codebase-pkg` (above) — it's indexed from current source. `wiki/architecture/` is a complementary, static, file-by-file map of the whole codebase — **476 first-party source files across 12 subsystems**, each read in full. Start at `wiki/architecture/INDEX.md`; there's one doc per subsystem. `wiki/cv-framework.md` is the hand-verified deep-dive exemplar (the computer-vision pipeline). Use these to **orient** — but they are auto-generated snapshots, so the graph and the actual file both override them. Always confirm against source before betting on any single line.

- **Generated at commit `4f0b473` (2026-06-13).** Staleness check: run `git rev-parse --short HEAD`. If it differs and source has moved much since, treat the maps as possibly out of date — confirm against the actual file (read it in full) or re-query `codebase-pkg`.
- **`sylphie-pkg` retired.** The old in-repo codebase-graph package was removed; codebase indexing now uses the external **`@sylphie-labs/codebase-pkg`** (MCP server `codebase-pkg`, its own Neo4j at `bolt://localhost:7692`, configured in `.mcp.json`). The wiki snapshot still contains a stale `sylphie-pkg.md` until the next refresh. See `sylphie-tech-spec.md §13`; the `/classify-pkg-domains`, `/infer-pkg-connections`, `/sync-pkg` skills target it.
- **To refresh:** the readers wrote JSON fragments to `wiki/architecture/_data/<subsystem>/`; `python wiki/_assemble.py` re-renders the markdown from them. `wiki/architecture-manifest.json` is the file inventory. A full re-read is a fan-out workflow (one agent per file) — see the build notes in the `project_architecture_docs` memory.

<!-- BEGIN planning-worx -->
@planning/planning-worx.rules.md
<!-- END planning-worx -->

## Intake pipeline (scheduled request automation)

`pipeline/` is a scheduled, file-based system that takes markdown requests from
`pipeline/inbox/` through plan → build → review as the front door to the two gates
above. Markdown items move through state folders
(`inbox → planning → refine → queue → working → review → done → archive`, with
`replan`/`refactor` off-ramps), driven by per-stage scheduled "cogs". All state moves
go through `pipeline/pipeline.py` (never hand-edit `pipeline/pipeline.json`); the
at-a-glance view is `pipeline/dashboard.html`. Current policy: `execute_mode=plan-only`,
`contract_write=staged`, never auto-merge, never wipe a DB (the repo-wide
`db-change-guard` hook enforces this). The full operating memory — cogs, schedule,
config knobs, safety invariants, gotchas, and live decisions — is imported below.

<!-- BEGIN intake-pipeline -->
@pipeline/pipeline.rules.md
<!-- END intake-pipeline -->
