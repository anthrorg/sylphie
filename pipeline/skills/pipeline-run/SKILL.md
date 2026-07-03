---
name: pipeline-run
description: "Going to bed" driver for the intake pipeline. Walks the manual stages — plan, refine, review, refactor, replan — advancing every ready item until nothing moves without Jim, and parks decisions in pipeline/decisions/. Use when you want the backlog pushed as far as it can go in one unattended run from Claude Code.
---

# pipeline-run — drive the backlog to done

The autonomous driver for the **manual** half of the intake pipeline. Running in Claude
Code in the repo, you walk every reasoning stage in dependency order, advance everything
you can, and loop until the pipeline reaches a fixpoint — nothing left that doesn't need
Jim or the scheduled overnight build. Then you report.

This is the "I'm going to bed, keep working the tickets" command.

## Before you start
1. Read `pipeline/config.json` and `pipeline/RUNBOOK.md`; re-read `planning/contract.yaml`. They win over anything you remember.
2. Open a run log: `pipeline/logs/pipeline-run-<UTC>.md`. Append what each stage does as you go.
3. Honor the config every pass: `max_items_per_tick` bounds how many items you advance per stage; `contract_write=staged` means **never** write `contract.yaml` directly (stage tickets inside the item's `plan.md`); ambiguity always routes to `replan` with the questions written down — never guessed.

## The loop
Repeat full passes until one pass advances **zero** items. In each pass, in this order:

1. **plan** — items in `planning/` (oldest first): run the `pipeline-plan` playbook (`RUNBOOK.md` §`pipeline-plan`). → `refine` or `replan`.
2. **refine** — items in `refine/`: run the `pipeline-refine` playbook — atomicity-gate + story-splitter, red-team with `plan-reviewer`. → `queue` or `replan`.
3. **review** — items in `review/`: run the `pipeline-review` playbook — `code-reviewer` + the subsystem's conceptual reviewer + verify/live-smoke. → `done`, `refactor`, or `replan`. Write a decision brief for every PR that is now review-clean and ready to merge.
4. **refactor** — items in `refactor/`: run the `pipeline-refactor` playbook — the owning domain expert applies the fix. → `queue` or `replan`.
5. **replan** — items in `replan/`: run the `pipeline-replan` playbook. Resolve what you can; otherwise write/refresh a brief in `pipeline/decisions/` and leave it parked.

**Use the real agents — that is the whole reason this runs by hand.** Discovery via
`codebase-pkg` + `reader`; red-team via `plan-reviewer`; code review via `code-reviewer`
plus the subsystem's conceptual reviewer; hard design/CANON forks via `architect`
(record its verdict in `docs/decisions/architect-log.yaml`). Follow the work-trio table
in `CLAUDE.md` for ownership.

## What you do NOT do
- **Never build / run `execute` / open PRs.** That is the scheduled overnight `execute` cog (gated on `execute_mode`). Leave `queue/` items for it. If Jim wants a full one-sitting drive that includes the build, he says so — don't build unprompted.
- **Never merge.** Review stops at "ready to merge"; the merge is always Jim's.
- **Never write `contract.yaml`** while `contract_write=staged`, and never wipe or alter a DB outside the migration path (the `db-change-guard` hook hard-blocks wipes).
- All state moves go through `pipeline.py` — never move a folder or edit `pipeline.json` by hand.

## Stop conditions
Stop when a full pass moves nothing — every remaining item is either queued (waiting for
the overnight build), parked at max attempts, or waiting on a decision in
`pipeline/decisions/`.

## Report (always)
Append the summary to the run log and print a digest:
- **DONE** — items that reached `done` (and what shipped).
- **QUEUED** — items now waiting for the scheduled overnight `execute` build.
- **WAITING ON YOU** — open decisions in `pipeline/decisions/` (each by id + one-line fork) and any PRs ready to merge.
- **PARKED** — items at max attempts, and why.
- Counts per state (`python pipeline/pipeline.py status`).
