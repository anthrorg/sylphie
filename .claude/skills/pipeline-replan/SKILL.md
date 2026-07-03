---
name: pipeline-replan
description: Run the pipeline REPLAN stage once from Claude Code — resolve design failures parked in pipeline/replan/. Records resolutions as governance decisions and sends items back to planning, or writes a decision brief to pipeline/decisions/ and leaves them parked for Jim. Use to re-run just the replan stage by hand.
---

# pipeline-replan — replan stage (replan → planning | park)

Run the REPLAN cog's playbook once, on items in `pipeline/replan/`.

1. Read `pipeline/config.json` and the `pipeline-replan` section of `RUNBOOK.md`. Log to `pipeline/logs/pipeline-replan-<UTC>.md`.
2. Read the recorded `open_question`s / `blocked_reason` in the item's `plan.md` and `item.json`.
3. **Resolvable now** — Jim has already answered in the item folder, or you can now write testable ACs (for a hard design/CANON fork, get an `architect` ruling first and cite it): record the resolution as a governance `decision` (append-only), then `pipeline.py move <id> planning --note "resolved: <decision>"` so it re-enters planning fresh.
4. **Needs Jim and he hasn't answered** — write or refresh a brief in `pipeline/decisions/` from `templates/decision.template.md` (context with file:line refs, the fork, options, recommendation, CANON lens) and leave the item parked. Do not guess.
5. At `max_replan_attempts` the helper parks the item — surface it, don't loop.

While `contract_write=staged`, only the append-only governance record may be written to the contract; never wipe a DB; all moves via `pipeline.py`.
