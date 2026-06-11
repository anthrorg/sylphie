# WS5-T1 — World-fact promotion + guardian-confirmation gate

**Status:** open (deferred from WS4 by decision §7.1, mythos with Jim's delegated authority, 2026-06-10) · **Owner:** atlas (schema) + builder

WS4 made self-reported facts OKG-only (no `target:'world'` extraction path exists). Consequence: a genuine world-fact taught by any speaker ("the Eiffel Tower is in Paris") helps no one else. This ticket adds the promotion path WITHOUT reopening the Std 3/Std 5 holes WS4 closed.

**Decided shape (build-plan §7.1.4):**
- A `CandidateWorldFact` staging store (Prisma table or `:Candidate` WKG node, `provenance_type='CANDIDATE'`, confidence capped at the speaker's tier — ≤0.60 non-guardian) — visible to reasoning as low-confidence, never GROUNDED.
- Promotion to a real WKG `Entity` at elevated confidence ONLY via explicit guardian action, reusing the existing `reportGuardianFeedback(turnId,'confirmation')` + `guardian_feedback` WS message with a `candidateId` variant. No new auth surface.
- Requires a `target:'world'` classification in fact extraction (currently emits only 'speaker'/'sylphie').

Interacts with: [[learning-pipeline-person-fact-wkg-leak]] (conversation-derived entities are arguably exactly the candidates this staging store should hold instead of entering WKG directly) and [[legacy-pattern-rescope-migration]].
