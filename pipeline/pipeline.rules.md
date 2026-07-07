# Intake Pipeline — operating memory

A scheduled, file-based system that takes markdown requests (bug reports, feature
lists, directives) from `pipeline/inbox/` through plan → build → review, as the
**front door** to this repo's two gates (planning-worx contract + workflow execution).
It does not replace planning-worx or worktree-agents; it feeds them on a schedule.
Full per-cog procedure: `pipeline/RUNBOOK.md`. User-facing overview: `pipeline/README.md`.

## State machine
`inbox → planning → refine → queue → working → review → done → archive`, with two
off-ramps: **replan** (design-level failure → back to planning) and **refactor**
(execution-level failure: build/test/review pushback → back to queue). Each item is a
namespaced folder `pipeline/<state>/<id>-<slug>/` holding `source.md` (verbatim
original), `plan.md`, optional `migration.md`, `item.json`, `log.md`. `pipeline.json`
is the index.

## pipeline.py — the deterministic mover (never hand-edit pipeline.json)
All state changes go through it; it does only mechanical, reversible work and makes no
judgments:
- `ingest` — inbox/*.md → namespaced items in planning/ (also sets a cheap `type`
  hint + `size_hint`/`lines`/`sections`; the type hint is non-authoritative — the plan
  cog is the real classifier; nothing branches on `type`).
- `move <id> <state> [--note|--reason] [--force]` — transition (enforces legal edges).
- `set <id> [--type --title --add-node TK.. --attempts N]`, `log <id> "msg"`.
- `show <id>`, `list [--state]`, `status`, `stuck [--hours N]`.
- `dbcheck <id>` — flags whether an item touches a DB surface and whether a
  migration.md is present (the DB gate; see below).
- `dashboard.py` — regenerates `pipeline/dashboard.html` (the at-a-glance kanban view;
  sweep regenerates it each morning, or run it manually).

## The cogs (HAND-DRIVEN — Jim removed the scheduler 2026-07-03)
Each reasoning cog runs as a `/pipeline-*` skill invoked by hand (`/pipeline-plan`,
`-refine`, `-refactor`, `-replan`, `-review`; or `/pipeline-run` to drive all reasoning
stages to a fixpoint). There is NO scheduled execution and NO execute cog anymore —
queue items are built by running `/worktree-agents` (or a coordinator-authored Workflow)
by hand; builds stop at an OPEN PR per execute_mode=to-pr. Dashboard/sweep run on demand
(`python pipeline/dashboard.py`).

## Config knobs — `pipeline/config.json`
- `execute_mode`: **to-pr** (current, Jim-ruled 2026-06-27 — builds go to an OPEN PR,
  never merged) vs `plan-only` (dry-run, no builds).
- `contract_write`: **autonomous** (current, Jim directive 2026-07-03 — process/
  decomposition ticket writes go straight into `planning/contract.yaml` with no Jim
  gate; only genuinely new application DIRECTION surfaces to him) vs `staged` (the old
  mode — every ticket/epic write waited for Jim's approval gate).
- `max_items_per_tick` (1), `max_replan_attempts`/`max_refactor_attempts` (2 → then the
  item is parked and surfaced, never auto-retried), `stuck_threshold_hours` (48),
  `archive_after_days` (14).

## Safety invariants (do not violate)
- **Never auto-merge.** Execute/review stop at "ready to merge"; the merge is Jim's.
- **Never wipe a DB to evolve a schema.** Enforced repo-wide by the `db-change-guard`
  PreToolUse hook (`pipeline/hooks/`), which hard-blocks `down -v`, `prisma migrate
  reset`, `reset:confirm`, DROP/TRUNCATE/DETACH DELETE, and edits to
  `infra/*/init/**`. Escape hatch for a genuinely necessary destructive change:
  `SYLPHIE_DB_CHANGE_APPROVED=1 <cmd>` or an `infra/migrations/.db-change-approved`
  marker citing a decision id (logged to `pipeline/logs/db-guard.log`; sweep flags a
  lingering marker). Policy + required migration-plan contents:
  `pipeline/policies/db-change-safety.md`; template: `migration-plan.template.md`.
- **Ambiguity routes to replan with the question written down — never guessed.**
- **The contract is append-only** (decisions/changelog supersede, never edit).
- **Discovery first** then read the whole file before reasoning/changing (repo rule).

## Adjacent capability — `/explore-topic` skill
Multi-agent reconciliation (debate across rounds), ported into this repo at
`pipeline/skills/explore-topic/`. Science seats (piaget, skinner, luria, ashby, scout)
on opus (judges — the former fable seats, remapped 2026-07-07); technical seats on sonnet; `canon` guards the Six Immutable Standards;
`architect` synthesizes/tie-breaks. It is the route for items too novel/cross-cutting
to plan flat. Install both staged pieces from the repo root:
`node pipeline/hooks/install-db-guard.cjs` and `node pipeline/skills/install-skills.cjs`
(`.claude/` is protected from agent edits, so installs are an explicit user step).

## Known gotchas
- **OneDrive mount lag:** in the bash sandbox, large files written via the file tools
  (Read/Write/Edit) can read back stale/truncated. Re-materialize via a bash heredoc,
  or use the Read tool (authoritative). Small files sync fine. `pipeline.py` /
  `config.json` have been written via bash so the sandbox copy is current.
- **Worktree paths:** real worktrees live at `../sylphie-wt/` and `.claude/worktrees/`,
  NOT `../sylphie-worktrees/` (the RUNBOOK cleanup section still names the wrong path —
  fix pending). Never blanket `git worktree prune`; only prune branches merged to main.
- **contract.yaml concurrency:** terminal build agents and the pipeline cogs can both
  write `contract.yaml`; coordinate (don't write it while it has another writer's
  uncommitted changes).

## Decisions (current policy — Jim-ruled 2026-06-27)
- `execute_mode = to-pr` — execute cog builds queue items to an OPEN PR via
  /worktree-agents; **never merges** (merge stays Jim's). (Flipped from plan-only.)
- `contract_write = autonomous` (**Jim directive 2026-07-03**, supersedes the
  2026-06-27 `staged` ruling) — **process/decomposition ticket writes are the
  coordinator's to make and go straight into `contract.yaml` with no Jim gate**:
  ticket splitting, decomposing already-approved intent, migration mechanics,
  implementing an `architect` ruling. Use `architect` for hard design/CANON calls, not
  Jim. **Only genuinely new application DIRECTION** (a new feature/capability, a
  priority/vision/non-goal change, a CANON change, or an irreversible/outward action
  like a PR merge) still surfaces to Jim before acting. Governance appends
  (decisions + changelog) remain append-only. A cog must NOT write `contract.yaml`
  while another writer has it dirty (concurrency guard — to be implemented).
- Item **001** (verbose.log rotation): **option A — per-process files `verbose.<pid>.log`**.
- Item **002** P0: **APPROVED** to write `EP-AUDIT` + `TK-AUDIT-1` (drive_rules REVOKE+RLS)
  into `contract.yaml` at the next safe plan-cog run; the design-needing findings
  (god-objects, EWC-confirm, dup) stay as `open_question`s for architect, not tickets.
- The cogs dedupe against existing contract work (e.g. item 003 attached to existing
  EP-20/TK-97..105 rather than cloning an epic) — good behavior, keep it.

## Open work (fixes pending, not blocking)
- RUNBOOK cleanup worktree path is wrong (`../sylphie-worktrees` → real `../sylphie-wt/`
  + `.claude/worktrees/`).
- Concurrency guard so cogs skip `contract.yaml` writes when it has another writer's
  uncommitted changes.
- Human-PR-comment → refactor loop + record `pr_url`/branch on items.
- Tighten `dbcheck`: prose mentions of "migration"/"postgres" false-positive (cog
  caught and corrected it, but worth fixing the keyword scan).

## How to drive it by hand
Run a cog: open `claude` in the repo and say "run the <cog> cog per pipeline/RUNBOOK.md".
Check state: open `pipeline/dashboard.html`, or `python pipeline/pipeline.py status`.
Resolve a parked item: answer its `blocked_reason`, then `pipeline.py move <id> planning`.
