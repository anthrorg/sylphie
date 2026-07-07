# Bug batch: the "Lower-8" learning/planning defects (split from item 20260702-006 per DEC-37)

Origin: item 20260702-006's source bundled 8 additional independently-rooted defects in its
"Lower" bullet list, outside that item's own Acceptance section. The 006 planner recommended
the split; architect APPROVED it (DEC-37 / AD-0059-0060, 2026-07-06). Filed here as its own
bug-batch item. Each defect below needs verification against current main before ticketing
(line refs are from the 006 source trace and may have drifted).

## P1 lead (architect-flagged: live CANON Std-3 violation)
1. **Unclamped INFERENCE confidence past the 0.60 ceiling** — `packages/learning/src/pipeline/confidence-decay.service.ts:239`: the reinforcement path can raise INFERENCE-provenance confidence above 0.60 without guardian confirmation. Architect: this is a live confidence-ceiling escape and leads this item.

## The rest (verify each, then ticket)
2. LLM-failure permanent reflection loss — a failed refinement call permanently drops the reflection instead of retry/dead-letter.
3. `markAsLearned` swallow -> duplicate `:Conversation` nodes on the next pass.
4. Sidecar HTTP 400s counted as circuit-breaker failures (client errors trip the breaker meant for outages).
5. Vacuous `ADDRESSES_OPPORTUNITY` constraint (the check cannot fail as written).
6. Unbounded `pendingInterventions` growth (no cap/expiry).
7. Decayed `:Candidate` orphans never pruned.
8. Non-transactional `updateEdgeType` (delete+create without a transaction; crash mid-way loses the edge).

## Constraints
- Items 1-8 are correctness bugs: default P1 unless verification shows lower stakes.
- Any fix touching provenance/confidence paths must respect DEC-37's rulings on item 006
  (no re-stamping outside the sanctioned migration; Std-4: no fabricated history).
