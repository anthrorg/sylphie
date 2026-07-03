---
name: pipeline-plan
description: Run the pipeline PLAN stage once from Claude Code — classify and plan items in pipeline/planning/ into staged contract tickets with testable acceptance criteria. Routes to refine (clean) or replan (ambiguous). Use to re-run just the plan stage by hand.
---

# pipeline-plan — plan stage (planning → refine | replan)

Run the PLAN cog's playbook once, by hand, on up to `max_items_per_tick` items in
`pipeline/planning/` (oldest first).

1. Read `pipeline/config.json` and the `pipeline-plan` section of `RUNBOOK.md`; re-read `planning/contract.yaml`. Log to `pipeline/logs/pipeline-plan-<UTC>.md`.
2. Read the item's `source.md` in full. Fix type/title: `python pipeline/pipeline.py set <id> --type <t> --title "..."`.
3. **Discovery first** — use `codebase-pkg` to locate the affected area, then `reader` to read the real files in full. Never plan against a guess.
4. Stage the ticket(s) inside the item's `plan.md` (**contract_write=staged — do NOT write `contract.yaml`**): each with ≥1 Given/When/Then acceptance criterion, priority, engineering_level, complexity_budget. Small/single-concern → one ticket; large/multi-part → run `/plan-design` then `/plan-tickets` for an epic + atomic tickets. Record every id: `pipeline.py set <id> --add-node TK-NN`.
5. **DB step** — `pipeline.py dbcheck <id>`. If it touches a DB, route to `sentinel`, add a migration + backfill AC, and start `migration.md` from `policies/migration-plan.template.md`.
6. Can't write a *testable* AC, or the item is genuinely novel/cross-cutting → `pipeline.py move <id> replan --reason "ambiguous: <questions>"` (note "needs /explore-topic" if it needs reconciliation). Otherwise → `pipeline.py move <id> refine --note "<node ids>"`.

All state moves go through `pipeline.py`; never wipe or alter a DB outside the migration path.
