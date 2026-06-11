# Legacy warm-pattern re-scoping migration (WS5 cleanup)

**Status:** open, optional · **Raised:** 2026-06-10 (mythos, T7 design) · **Decision needed from Jim:** is this wanted?

293 legacy world-scoped (`grounding_person_id IS NULL`) GROUNDED patterns in `learned_patterns` contain Jim's personal facts in their response text ("Your name is Jim, and you live in Seattle", dog Max, etc.). T5 §3.4 deliberately left legacy rows world-scoped (person-scoping them would gut the warm layer). Consequence: for name/city/dog-class keys, a future Person B could receive a GROUNDED reply citing Jim's facts — a CANON-sanctioned latent leak the T7 gate deliberately does not assert against (it probes only fresh nonce keys).

**If** guardian-private facts taught pre-T5 must never leak to any future interlocutor: run a one-time migration re-attributing legacy identity-class patterns (response text matching the guardian's OKG fact values) to `grounding_person_id='guardian'`. The T5 replay-demotion then covers them automatically. Cost: those patterns demote to UNKNOWN for non-guardian speakers (correct), unchanged for Jim.

Not a WS4 blocker. Pairs naturally with WS5-T1 (world-fact promotion) and the learning-pipeline leak ticket ([[learning-pipeline-person-fact-wkg-leak]]).
