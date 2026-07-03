# Feature: Gate-proven behavior ledger — the metric that says whether Sylphie is working

From Jim/adversarial review, 2026-07-02. Small, cheap, high-leverage.

## The problem

The project's honest success metric is: **what observable behavior does Sylphie exhibit
that is attributable to her architecture rather than to the LLM's priors — proven by a
gate that watched it happen?** (Grounded recall, perception-moves-drives, drive-gated
proactive comments, use→reinforce edges — these exist, but scattered across contract
tickets, gate specs, and memory.) Nothing enumerates them; nothing tracks whether the
list grows. Meanwhile `occam`'s deletion dockets are supposed to report "scope LOC vs.
gate-proven behaviors in scope" — a ratio with no denominator, because the behaviors
were never counted.

## What to build

A single living document — `docs/behavior-ledger.md` (or similar) — one row per
gate-proven distinctive behavior:

- The behavior, stated as what she *does* (not the mechanism name).
- The runnable gate/check that proves it (command + spec path), and last-verified date +
  commit.
- Status: PROVEN (gate green at last run) / REGRESSED (gate exists, currently red) /
  UNPROVEN-CLAIM (asserted somewhere but no gate — these rows are the shame list).

Plus the two headline numbers at the top: behavior count, and total first-party LOC per
proven behavior. Occam's dockets cite this ledger for their ratio.

## Acceptance criteria (sketch)

- Initial population: sweep planning/contract.yaml done-tickets' acceptance criteria +
  test/gate specs, enumerate every behavior with a runnable proof; each row's gate
  command actually runs and its result is recorded honestly (red rows stay in, marked
  REGRESSED).
- A documented one-command way to re-verify the ledger (run all listed gates, refresh
  statuses/dates).
- occam.md's docket-header instruction points at the ledger as the denominator source.

## Non-goals

- No new gates (this catalogs existing proof, it doesn't create it).
- No dashboard/UI — a markdown table is the product.
- No automation beyond the re-verify script; keeping it current is a session-wrap habit.

## DB impact

None.
