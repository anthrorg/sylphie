# pipeline — markdown intake → plan → build

Drop a markdown file describing a bug, a feature, or a chore into **`inbox/`**. The
pipeline carries it forward one stage at a time: ingest it, plan it into
`planning/contract.yaml`, refine the plan until it's atomic, build it to an open PR via
`/worktree-agents`, review and verify, then archive. Design problems fall to
**`replan`**; execution problems fall to **`refactor`**. Everything is logged.

This is a thin front door onto the repo's existing machinery — planning-worx for the
plan, worktree-agents for the build, the work-trio for review. It doesn't replace any
of it; it feeds them.

## Two modes (changed 2026-07-02)

The pipeline no longer runs entirely on a timer. Stages are split by whether they need
judgment:

- **Mechanical stages stay scheduled** — `ingest`, `execute` (the overnight build),
  `cleanup`, `sweep`. No judgment required, so they wake on their own clock.
- **Reasoning stages run by hand from Claude Code** — `plan`, `refine`, `review`,
  `refactor`, `replan`. These want the real agent roster (`architect`, `plan-reviewer`,
  `code-reviewer`, the conceptual reviewers), which only loads when you run `claude` in
  the repo. So they're invoked as **skills in your terminal**, not on a schedule. The
  matching scheduled tasks are disabled.

## The machine

```
inbox → planning → refine → queue → working → review → done → archive
                ↘ replan ↙        ↘ refactor ↙
```

- **replan** = the plan was wrong/ambiguous → back to `planning`.
- **refactor** = the plan was fine but the work came back deficient → back to `queue`.

Each item is a folder `<state>/<id>-<slug>/` holding `source.md`, `plan.md`,
`item.json`, and `log.md`. Bigger plans namespace naturally — the folder is the
namespace, and `item.json` lists every `contract.yaml` ticket the item spawned.

## The cogs

| Cog | Reads | Writes to | Runs as |
|---|---|---|---|
| `ingest`   | inbox    | planning                  | **scheduled** (am + pm) |
| `plan`     | planning | refine / replan           | skill **`/pipeline-plan`** |
| `refine`   | refine   | queue / replan            | skill **`/pipeline-refine`** |
| `execute`  | queue    | review / refactor         | **scheduled** (overnight) |
| `review`   | review   | done / refactor / replan  | skill **`/pipeline-review`** |
| `refactor` | refactor | queue / replan            | skill **`/pipeline-refactor`** |
| `replan`   | replan   | planning / park           | skill **`/pipeline-replan`** |
| `cleanup`  | done     | archive                   | **scheduled** (overnight) |
| `sweep`    | all      | reports only              | **scheduled** (morning) |

Full procedure for every cog is in **`RUNBOOK.md`** — the skills run the same playbooks.

## Running it from Claude Code

Open `claude` in the repo. One command drives everything; the others are single stages.

### Drive the whole backlog — `/pipeline-run`

"I'm going to bed" mode. Walks every manual stage in order (plan → refine → review →
refactor → replan), advancing every item it can, section by section, looping until
nothing moves without you. Queued items are left for the scheduled overnight `execute`
build. Anything that needs your call is written to **`pipeline/decisions/`** as a
standard decision brief. Ends with a `DONE / WAITING-ON-YOU / PARKED` digest.

### Run one stage — `/pipeline-plan` · `/pipeline-refine` · `/pipeline-refactor` · `/pipeline-replan`

Each runs exactly its `RUNBOOK.md` playbook once, on up to `max_items_per_tick` items in
that state. Use when you only want to re-run a single stage.

### Review + decisions — `/pipeline-review`

Runs code review + verification on everything in `review/`, routes each item
(done / refactor / replan), then gathers everything that needs a decision from you —
PRs reviewed and ready to merge, parked `replan` questions, items at max attempts — into
`pipeline/decisions/`, one **standard entry** each (`templates/decision.template.md`):
context with file:line refs, the fork, the options with trade-offs, a recommendation,
and the CANON lens. Merging is always yours; no skill ever merges.

### Install / update the skills

The skills are staged in `pipeline/skills/`. Because an agent session can't write into
`.claude/`, you install them yourself (an explicit, auditable opt-in):

```
node pipeline/skills/install-skills.cjs          # copies pipeline/skills/* → .claude/skills/*
node pipeline/skills/install-skills.cjs --list    # preview without copying
```

Restart/reload the Claude session for new skills to register.

## Authoring an inbox item

Save a markdown file in `pipeline/inbox/`. The first heading becomes the title. Be
concrete — a vague file becomes a `replan` later. A good bug report says what's broken,
what's expected, and how to reproduce; a feature file lists the capabilities. Templates
live in `pipeline/templates/`.

## Check progress any time

```
python pipeline/pipeline.py status     # counts per state + anything parked
python pipeline/pipeline.py stuck        # items stuck past the threshold
python pipeline/pipeline.py list          # every item, its state and tickets
python pipeline/pipeline.py show <id>     # one item's full record
```

## Drive state by hand

`pipeline.py` makes no decisions — only mechanical, enforced state moves:

```
python pipeline/pipeline.py ingest                           # inbox/*.md → planning/
python pipeline/pipeline.py move <id> queue --note "..."     # advance a state
python pipeline/pipeline.py move <id> replan --reason "..."  # design off-ramp
python pipeline/pipeline.py move <id> refactor --reason "..."# execution off-ramp
python pipeline/pipeline.py set  <id> --add-node TK-42        # record a contract ticket
```

Legal transitions are enforced; override with `--force --reason "..."`. Never move a
folder or edit `pipeline.json` by hand.

## Decisions folder

`pipeline/decisions/` is where the reasoning stages leave anything that needs your
ruling, each as one self-contained brief from `templates/decision.template.md`. When you
decide, fill in the **Decision** block; the resolution is recorded to governance
(`planning/contract.yaml` `decisions`) or `docs/decisions/architect-log.yaml`, and the
`replan` stage carries the item back into `planning`.

## Knobs — `config.json`

- `max_items_per_tick` — how many items a cog may **advance** per run.
- `execute_mode` — `to-pr` builds queued items to an open PR; `plan-only` stops after
  queuing.
- `contract_routing` — `EP-21` (the rolling intake epic; default), `per-project`, or `active`.
  Intake epic/ticket ids must be numeric (`EP-<n>`/`TK-<n>`) to satisfy the planning-worx schema.
- `max_replan_attempts` / `max_refactor_attempts` — after this many failed cycles an
  item is parked for you and never retried automatically.
- `stuck_threshold_hours` / `archive_after_days` — watchdog and cleanup thresholds.

## The scheduled cogs (mechanical only)

`ingest` (am/pm), `execute`, `cleanup`, and `sweep` remain scheduled tasks under
`…\Documents\Claude\Scheduled\`, named `pipeline-<cog>`, each running its RUNBOOK section
and logging to `pipeline/logs/`. The reasoning cogs are disabled as scheduled tasks —
run them via the skills above.

> Scheduled tasks run while the Claude desktop app is open. If the app is closed when a
> run is due, it runs on next launch.
