---
name: poc-router
description: Route risky/ambiguous tickets through an early proof-of-concept — prove feasibility before committing the dependent build.
---

# poc-router

A ticket that *imposes risk or ambiguity* must not sit in the build order on faith.
Extract the uncertain core into a **POC** sequenced AHEAD of the work that depends on
it, so we prove we can do what the ticket claims before building on it.

## Route a POC if ANY hold (else do NOT — a POC for a known-doable ticket is theater)
- **Feasibility unknown** — the approach is unproven on this substrate (a new
  dependency or model, a cross-process/protocol seam, a perf/latency budget, an
  external API we have not actually called).
- **Ambiguous approach** — more than one plausible implementation and the choice
  materially changes the dependents.
- **Load-bearing assumption** — a downstream cluster rests on a claim that is asserted
  but unproven (a "should work", not a "verified").
- **High blast radius** — getting it wrong forces rework of multiple dependent tickets
  (cheaper to fail fast in a POC).

## Routing mechanic
1. **Create the POC node** — a small `ticket` (or `task`) carrying a `poc` block:
   `question` (the single thing it must answer), `hypothesis`, `status: open`. Its
   `acceptance_criteria` ARE the runnable check that answers the question — nothing
   more. Keep it throwaway-cheap.
2. **Sequence it AHEAD** — minimal/no `depends_on` so it is immediately ready, ordered
   before the risky work.
3. **Gate the dependents** — set the risky ticket (and anything it blocks) to
   `depends_on` the POC. They may not start until it is `done` AND its `poc.status` is
   `proven`.
4. **Resolve** — success → set `poc.status: proven` (+ `result`); optionally record a
   `decision` carrying the proven approach into the dependents. Failure →
   `poc.status: disproven`, STOP, and re-plan the dependents (the original approach is
   invalid) — record a governance `issue`/`open_question`.

## Notes
- A POC proves feasibility; it is NOT the implementation. Keep its scope to the
  question — the real ticket is still built (now de-risked) afterward.
- One POC per distinct unknown; don't bundle two risks into one POC.
- Composes with `story-splitter`'s Spike pattern — a Spike IS a POC node.
