# Red-team findings — 20260702-003 (refine cog, 2026-07-02, plan-reviewer)

Verdict: **REPLAN** — 2 CRITICAL (both on 003c) + 2 HIGH unresolved; 003a fails
atomicity. Source's 6 load-bearing claims re-verified and hold, EXCEPT one (finding 3).

## CRITICAL
1. **003c AC as written violates CANON provenance/theater standards.** The GROUNDED
   early-return (deliberation/recall-retrieval.ts:517-518) sits beside a second guard,
   `valueSurfacesAsWord` (:525-527), which enforces C2/C8.1 Std-1: the fact VALUE must
   surface in the response as a whole word for GROUNDED to be honest. "Return factNodeId
   even when already GROUNDED" would thread provenance for a fact never surfaced —
   fabricated provenance. AC must keep the surface check gating provenance; record the
   design call as a decision before build.
2. **003c wrong root cause + non-existent file path.** files_in_scope lists
   `packages/decision-making/src/recall-retrieval.ts` — actual path is
   `src/deliberation/recall-retrieval.ts`. And the null provenance on the common path is
   caused upstream: deliberation.service.ts:425-430 sets knowledgeGrounding='GROUNDED'
   (person-fact/topical-WKG) BEFORE applyRecallGroundingFromRetrieval (:446) → short-
   circuit. Real fix = order/merge the two grounding signals at deliberation.service.ts
   :420-450, preserving the surface guard.

## HIGH
3. **Plan's `discriminateGroundedBy` "production-dead" premise is FALSE** — it is called
   at deliberation.service.ts:70 and threaded via decision-making.service.ts:1516. Drop
   that speculation; the missing link is groundingProvenance, not groundedBy.
4. **003a self-tick fix mechanism unspecified → false-green risk.** The finally at
   decision-tick-engine.service.ts:390-398 already clears selfTickInFlight; it only
   fails if processInput never returns. The AC really tests "does the chat timeout
   unwedge processInput" — must state whether the fix is an AbortSignal into
   client.chat() or a scoped watchdog, and assert the socket actually aborts, not just
   that the flag clears. Also: a self-tick watchdog that fires without calling
   notifyExternalComplete() (:403) re-creates the queued-turns-forever bug — add that AC.

## MEDIUM/LOW (carry into replan)
- 003b deferred design fork IS a hole: "lower threshold" (theater-adjacent, skips needed
  deliberation) vs "real confidence signal" (exceeds S budget). Pre-decide: threshold
  stopgap recorded as a decision + backlog item for the real signal, or re-budget.
- 003b AC not binary ("fewer LLM calls" has no baseline) → reword to "0 for/against
  debate calls for a candidate with confidence ≥ threshold, non-empty WKG, anxiety ≤0.5".
- "Lower:" laundry-list deferral is sound; but note in 003a that the self-tick TOCTOU
  (same file/region) is knowingly out of scope.
- 003b/003c both edit deliberation.service.ts (non-overlapping regions :641-660 vs
  :420-450) — don't run simultaneously; sequence 003c after 003b.
- migration.md n/a record verified correct.

## Atomicity verdicts
003a SPLIT → 003a-1 epoch-guarded release (cycle-guard, ship alone first, S);
003a-2 chat timeout + self-tick unwedge (coupled, keep together, S/M);
003a-3 breaker half-open auto-probe (independent, mirror CycleGuard pattern, S).
003b PASS on atomicity, REPLAN on content (design fork + AC).
003c REWRITE (wrong file, wrong root cause, CANON-contradicting AC), then clean S slice.
