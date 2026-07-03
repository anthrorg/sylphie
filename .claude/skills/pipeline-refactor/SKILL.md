---
name: pipeline-refactor
description: Run the pipeline REFACTOR stage once from Claude Code — rework execution failures in pipeline/refactor/ (build/test/review deficiencies) and re-queue them for the next build. Routes to queue (fixed) or replan (actually a design problem). Use to re-run just the refactor stage by hand.
---

# pipeline-refactor — refactor stage (refactor → queue | replan)

Rework deficient *execution* — no re-planning. Run the REFACTOR cog's playbook once, on
up to `max_items_per_tick` items in `pipeline/refactor/`.

1. Read `pipeline/config.json` and the `pipeline-refactor` section of `RUNBOOK.md`. Log to `pipeline/logs/pipeline-refactor-<UTC>.md`.
2. Read the item's `blocked_reason` and the review/build findings in its folder. Hand the fix to the owning domain expert (work-trio table in `CLAUDE.md`); apply it in the item's worktree/branch.
3. Reworked and ready to rebuild → `pipeline.py move <id> queue --note "fixed: <what>"`. If the failure turns out to be a *design* problem, not an execution one → `pipeline.py move <id> replan --reason "<why>"`.
4. At `max_refactor_attempts` the helper parks the item — leave it for Jim, do not retry.

Deliver any schema change via the incremental migration path only — never an init-script edit (the `db-change-guard` hook hard-blocks wipes). All moves via `pipeline.py`.
