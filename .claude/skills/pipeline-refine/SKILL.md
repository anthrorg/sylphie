---
name: pipeline-refine
description: Run the pipeline REFINE stage once from Claude Code — the readiness gate. Atomicity-check and red-team the staged tickets for items in pipeline/refine/, splitting non-atomic ones, before they reach the build queue. Routes to queue (clean) or replan (design hole). Use to re-run just the refine stage by hand.
---

# pipeline-refine — refine stage (refine → queue | replan)

Run the REFINE cog's playbook once, on up to `max_items_per_tick` items in
`pipeline/refine/`. The question is "is every ticket truly atomic and ready to build?"

1. Read `pipeline/config.json` and the `pipeline-refine` section of `RUNBOOK.md`; re-read `planning/contract.yaml`. Log to `pipeline/logs/pipeline-refine-<UTC>.md`.
2. **Atomicity** — apply the `atomicity-gate` skill to the item's staged tickets. Any ticket that isn't atomic → split with `story-splitter`; update the item's node list. Iterate to fixpoint.
3. **Red-team** — run the `plan-reviewer` agent. Record CRITICAL/HIGH findings as governance `open_question`s / `risk`s.
4. **DB gate** — `pipeline.py dbcheck <id>`. If it touches a DB and `migration.md` is missing or weak (no backfill assessment, no REVERSE, init-script delivery) → `replan`. Nothing reaches `queue` with an unsound migration plan.
5. Route — an unresolved CRITICAL or a revealed design hole → `pipeline.py move <id> replan --reason "<finding>"`. Clean + atomic → `pipeline.py move <id> queue --note "atomic, red-teamed clean"`.

Honor contract_write=staged (don't write `contract.yaml`); never wipe a DB; all moves via `pipeline.py`.
