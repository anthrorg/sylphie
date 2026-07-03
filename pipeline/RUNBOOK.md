# Pipeline RUNBOOK — the cogs

The intake pipeline is the **front door** to this repo's two-gate system:

- **Gate 1 (plan):** every piece of work becomes node(s) in `planning/contract.yaml`
  with testable acceptance criteria. The *plan* and *refine* cogs produce those.
- **Gate 2 (execute):** ready tickets are built as a workflow via `/worktree-agents`,
  which stops at an open PR for Jim to merge. The *execute* cog drives that.

Each **cog** looks at the items sitting in its input state, advances what it can, and
stops. The state folders are the buffers between cogs, so the cogs are decoupled — a
cheap cog (ingest) can run often while an expensive one (execute) runs rarely.

**How each cog runs (changed 2026-07-02):** the mechanical cogs — `ingest`, `execute`,
`cleanup`, `sweep` — stay **scheduled tasks** on their own clocks. The reasoning cogs —
`plan`, `refine`, `review`, `refactor`, `replan` — now run **by hand from Claude Code**
as skills (`/pipeline-run` to drive them all, or `/pipeline-plan` etc. for one stage),
because they need the real agent roster that only loads in a repo `claude` session. Their
scheduled tasks are disabled. The playbooks below are identical either way — a skill runs
the same steps a cog did.

**Every cog run starts cold** with no memory of previous runs. All state lives on
disk: the folders, `item.json`, `log.md`, and `pipeline.json`. Re-read
`planning/contract.yaml` and `pipeline/config.json` at the start of every run — they
win over anything you remember.

**All folder moves go through `pipeline.py`.** Never move a folder or edit
`pipeline.json` by hand. The helper enforces legal transitions and keeps the index,
the item record, and the log in sync atomically.

---

## The machine

```
inbox → planning → refine → queue → working → review → done → archive
                ↘ replan ↙        ↘ refactor ↙
   replan  (design failure)   → planning   (re-plan after Jim clarifies)
   refactor(execution failure)→ queue      (rework, no re-plan needed)
```

`replan` and `refactor` are the two off-ramps and they are **not** the same thing:

- **replan** — the plan was wrong, ambiguous, or un-testable. The *design* is the
  problem. Goes back to `planning`.
- **refactor** — the plan was fine but the work came back deficient: build failed,
  tests won't pass, code review or the quality gate pushed back. The *execution* is
  the problem. Goes back to `queue` for a rebuild, no re-planning.

An item is the folder `<state>/<id>-<slug>/` with `source.md` (verbatim original),
`plan.md` (written by the plan cog), `item.json` (state + the contract node ids it
owns + attempt counters), and `log.md` (append-only).

---

## The cogs

| Cog (scheduled task) | Reads | Writes to | Backed by |
|---|---|---|---|
| `pipeline-ingest`   | inbox    | planning            | `pipeline.py ingest` |
| `pipeline-plan`     | planning | refine / replan     | `/plan-design`, `/plan-tickets` |
| `pipeline-refine`   | refine   | queue / replan      | `atomicity-gate`, `story-splitter`, `plan-reviewer` |
| `pipeline-execute`  | queue    | working→review / refactor | `/worktree-agents`, `pick_ready.py` |
| `pipeline-review`   | review   | done / refactor / replan | `code-reviewer` + conceptual reviewer + live-smoke |
| `pipeline-refactor` | refactor | queue / replan      | owning domain expert (work-trio) |
| `pipeline-replan`   | replan   | planning (or park)  | `/plan-clarify`, governance open_questions |
| `pipeline-cleanup`  | done     | archive             | `pipeline.py` + worktree prune |
| `pipeline-sweep`    | all      | (reports only)      | `pipeline.py status` + `stuck` + `/plan-status` |

Honor `config.json` everywhere: `max_items_per_tick` bounds how many items a cog may
advance per run; `execute_mode` gates the execute cog; `contract_routing` decides
where plan/refine write tickets; the `max_*_attempts` knobs decide when an item is
parked. Start each run by appending a line to `logs/<cog>-<UTC-timestamp>.md`.

---

## DB-Change Safety gate  (cross-cutting — `pipeline/policies/db-change-safety.md`)

Sylphie must never be wiped to evolve a schema. Any item touching a DB surface
(`infra/postgres/**`, `infra/timescaledb/**`, `infra/migrations/**`,
`prisma/schema.prisma` + `prisma/migrations/**`, any `*.sql`/`*.cypher`, pgvector
dims, embedding dim/version constants) must carry a `migration.md` (from
`policies/migration-plan.template.md`) before it leaves **refine** or is marked
**done**. Run `python pipeline/pipeline.py dbcheck <id>` to detect this — it reports
whether the item touches a DB and whether the plan is present. The `db-change-guard`
hook enforces the same boundary repo-wide and hard-blocks wipe commands. Plan,
refine, execute, review, and sweep each have a DB step below.

## Cog playbooks

### `pipeline-ingest`  (inbox → planning)
Purely mechanical. Run `python pipeline/pipeline.py ingest`. It moves each loose
`inbox/*.md` into a namespaced item folder in `planning/`, guesses a type, and logs
it. No judgment here. Done.

### `pipeline-plan`  (planning → refine | replan)
For each item in `planning/` (oldest first, up to `max_items_per_tick`):
1. Read `source.md` in full. Fix the type/title: `pipeline.py set <id> --type <t>`.
2. **Discovery first** (repo rule): use `codebase-pkg` MCP to find the affected area,
   then read the real files. Never plan against a guess.
3. Route into the contract per `contract_routing` (see note below). **Small/single
   concern** → add one well-formed ticket (≥1 Given/When/Then AC, priority,
   engineering_level, complexity_budget). **Large/multi-part** → run `/plan-design`
   then `/plan-tickets` for an epic + atomic tickets. Record every created id:
   `pipeline.py set <id> --add-node TK-NN`.
   **DB step:** run `pipeline.py dbcheck <id>`. If it touches a DB, route to the
   `sentinel` agent, add a migration + backfill acceptance criterion, and start a
   `migration.md` from the template — per the DB-Change Safety gate above.
4. If you cannot write a *testable* acceptance criterion, do not guess →
   `pipeline.py move <id> replan --reason "ambiguous: <questions>"` and record the
   questions as governance `open_question`s. Otherwise write `plan.md` and
   `pipeline.py move <id> refine --note "<node ids>"`.

### `pipeline-refine`  (refine → queue | replan)
The readiness gate — "is every ticket truly atomic and ready to build?"
1. For the item's contract tickets, apply the `atomicity-gate` skill. Any ticket that
   isn't atomic → split with `story-splitter` (update the contract + the item's node
   list). Iterate to fixpoint, just like `/plan-tickets`.
2. Red-team with the `plan-reviewer` agent. Record CRITICAL/HIGH findings as
   governance `open_question`s/`risk`s.
3. **DB gate:** `pipeline.py dbcheck <id>`. If it touches a DB and `migration.md`
   is missing or weak (no backfill assessment, no REVERSE, init-script delivery) →
   `replan`. An item must not reach `queue` with an unsound migration plan.
4. If an unresolved CRITICAL remains, or splitting revealed a design hole →
   `pipeline.py move <id> replan --reason "<finding>"`. If clean →
   `pipeline.py move <id> queue --note "atomic, red-teamed clean"`.

### `pipeline-execute`  (queue → working → review | refactor)
Only if `execute_mode == to-pr`. If `plan-only`, just log what *would* build and stop.
1. Confirm readiness deterministically: `python .claude/workflows/pick_ready.py`.
   The item's tickets must appear (all deps `done`).
2. For up to `max_items_per_tick` items: `pipeline.py move <id> working`, then run
   `/worktree-agents <N>` for the item's ticket count. The build agent explores,
   implements the simplest thing meeting the ACs, writes tests, opens a PR. It
   **never merges**.
3. PR opened with green checks → `pipeline.py move <id> review --note "PR <url>"`.
   Build failed / tests won't pass → `pipeline.py move <id> refactor --reason "<why>"`.
   **DB step:** the build agent delivers any schema change via the incremental
   migration path only — never an init-script edit. The `db-change-guard` hook will
   hard-block a wipe; if the agent hits that wall, that's a `refactor`, not an override.

### `pipeline-review`  (review → done | refactor | replan)
Code review **and verification** folded into one gate. This cog will get richer over
time — treat the verify half as the part still being built out.
1. **Code review** — run `code-reviewer` (read-only) plus the subsystem's conceptual
   reviewer per the work-trio table in `CLAUDE.md`. A `BLOCKED (CANON)` verdict stops
   everything.
2. **Verify it runs** — execute the ticket's runnable acceptance checks and
   `gate_check.js`; for anything that touches a live path, bring the service up and
   watch the critical path (the `CLAUDE.md` live-smoke / architect sign-off rule).
   **DB continuity smoke:** if the item touched a DB, seed representative data →
   apply the migration forward → assert the pre-existing data survived intact (and
   the index/constraint is rebuilt). Data loss without a recorded `decision` →
   `refactor` (or `replan` if the migration design itself is wrong).
3. Clean + verified → `pipeline.py move <id> done --note "reviewed + smoke-passed"`.
   Changes requested or a check failed → `pipeline.py move <id> refactor --reason
   "<finding>"`. If review exposes a *design* flaw (not just a code fix) →
   `replan` instead.

### `pipeline-refactor`  (refactor → queue | replan)
Rework deficient execution — no re-planning.
1. Read the `blocked_reason` and the review/build findings. Hand the fix to the owning
   domain expert (work-trio). Apply the fix in the worktree/branch.
2. Reworked and ready to rebuild → `pipeline.py move <id> queue --note "fixed: <what>"`.
   If the failure turns out to be a design problem, not an execution one →
   `pipeline.py move <id> replan --reason "<why>"`.
3. At `max_refactor_attempts` the helper parks it — leave it for Jim, do not retry.

### `pipeline-replan`  (replan → planning | park)
1. Read the recorded `open_question`s / `blocked_reason`. If they need Jim's input and
   it isn't available, leave the item parked and ensure `sweep` will surface it.
2. Once resolved (Jim answered, or you can now write testable ACs): record the
   resolution as a governance `decision`, then `pipeline.py move <id> planning
   --note "resolved: <decision>"` so it re-enters planning fresh.
3. At `max_replan_attempts` the helper parks it — surface, don't loop.

### `pipeline-cleanup`  (done → archive + housekeeping)
1. Move `done/` items older than `archive_after_days` to `archive/`:
   `pipeline.py move <id> archive`.
2. Prune merged git worktrees under `../sylphie-worktrees/` and rotate stale files in
   `pipeline/logs/`. Never delete an item's folder — archive keeps the record.

### `pipeline-sweep`  (digest + watchdog — reports only)
1. `python pipeline/pipeline.py status` and `... stuck` (uses `stuck_threshold_hours`).
2. Write a daily digest to `logs/digest-<date>.md`: counts per state, what moved,
   PRs now reviewed and **ready for Jim to merge** (merge is never automated), items
   `parked_at_max_attempts`, and anything `stuck`. This is the one consolidated
   notification so the other cogs can stay quiet.
3. **DB-guard hygiene:** flag if `infra/migrations/.db-change-approved` is lingering
   (approval left on) and surface any `pipeline/logs/db-guard.log` overrides since the
   last digest, so a wipe approval can never quietly stay enabled.

---

## Contract routing  (`config.json: contract_routing`)
- **`EP-21`** (default) — plan/refine nest all pipeline tickets under a single rolling
  intake epic (`EP-21`, parent `FEAT-3`) in the active `contract.yaml` (create it once if
  absent). Keeps intake work visibly separate from the in-flight project. **Ids must be
  numeric** — `EP-<n>`/`TK-<n>` per the planning-worx schema `/^(FEAT|EP|TK|TASK)-\d+$/`
  (a semantic id like the old `EP-INTAKE` is rejected by the validator hook). A larger
  item that warrants its own epic gets the next free `EP-<n>` at write time, under `FEAT-3`.
- **`per-project`** — each project gets `planning/contracts/<project>.yaml`; the item's
  triaged project decides which file. (Needs the per-project contract scaffolding.)
- **`active`** — append straight into the main contract alongside current work.

## Rules that keep this safe
- **Bounded blast radius** — never *build* more than `max_items_per_tick` per run.
  Planning many is fine; building many is not.
- **Never auto-merge** — execution and review stop at "ready to merge". The merge is
  always Jim's.
- **Contract-write boundary** — when `contract_write: staged` (default), the plan and
  refine cogs produce the ticket inside the item's `plan.md`; the write into
  `contract.yaml` happens only at an explicit approval gate, never autonomously. Flip
  to `autonomous` once plan quality has a track record.
- **Ambiguity always routes to `replan`** with the questions written down — never
  silently guessed.
- **Stagger contract writers** — `plan`, `refine`, `refactor`, `replan` all mutate the
  contract; their schedules must not collide on the same minute.
- **The contract is the record** (append-only for `decisions`/`changelog`); **if it
  isn't logged, it didn't happen.**
