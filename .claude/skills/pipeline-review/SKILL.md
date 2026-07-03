---
name: pipeline-review
description: Review the pipeline's open PRs and surface every decision that needs Jim. Runs code review + verification on items in review/, routes each (done/refactor/replan), then collects everything awaiting a ruling — merge-ready PRs, parked replan questions, items at max attempts, CANON/design forks — into pipeline/decisions/ as one standard brief each. Use to clear the review stage and get a clean decision list.
---

# pipeline-review — review + decisions

Two jobs: (1) run the **review** cog on everything in `review/`, and (2) consolidate
everything that needs Jim's decision into `pipeline/decisions/`, each as one standard
context entry he can act on without hunting.

## Before you start
Read `pipeline/config.json` and the `pipeline-review` section of `RUNBOOK.md`. Open a log
at `pipeline/logs/pipeline-review-<UTC>.md`.

## 1. Review every item in `review/` (up to `max_items_per_tick`)
Per the RUNBOOK playbook:
1. **Code review** — run `code-reviewer` (read-only) plus the subsystem's conceptual reviewer per the work-trio table in `CLAUDE.md`. A `BLOCKED (CANON)` verdict stops that item.
2. **Verify it runs** — execute the ticket's runnable acceptance checks and `gate_check.js`; for anything on a live path, bring the service up and watch the critical path (the live-smoke / architect sign-off rule). If it touched a DB, run the continuity smoke (seed → migrate forward → assert pre-existing data survived).
3. **Route** — clean + verified → `pipeline.py move <id> done`. Changes requested / a failed check → `refactor`. A *design* flaw (not just a code fix) → `replan`. **Never merge** — the PR is left for Jim.

## 2. Build the decision list → `pipeline/decisions/`
Sweep the whole pipeline for anything that needs Jim, and write or refresh one brief per
issue from `pipeline/templates/decision.template.md`:
- **PRs reviewed and ready to merge** (from step 1) — the merge is always Jim's.
- **Parked `replan` items** — read each item's `open_question`s / `blocked_reason`; render the fork, the options with trade-offs, a recommendation, the CANON lens, and file:line refs.
- **Items `parked_at_max_attempts`** — from `python pipeline/pipeline.py stuck` / `status`.
- **Any CANON or architectural fork** raised in review — for a hard design call, gather cheap context and hand it to `architect`; capture its recorded verdict (`docs/decisions/architect-log.yaml`) in the brief.

One file per decision: `pipeline/decisions/<pipeline-item-id>-<slug>.md`. If a brief
already exists for an issue, update it in place — don't duplicate. Keep `Status: OPEN`
until Jim fills the **Decision** block.

## Report
Print: the items routed (done / refactor / replan), then a numbered list of the open
decisions now in `pipeline/decisions/` — each `<id>`, its one-line fork, and your
recommendation. That list is exactly what Jim acts on.
