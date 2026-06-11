# Learning-pipeline person-fact leak into shared WKG

**Status:** open · **Found:** 2026-06-10 (mythos, WS4 Ticket 5 verification) · **Owner:** atlas (design), then builder · **Severity:** HIGH — CANON three-graph-isolation breach · **Tracked also at:** stub inventory §2.8

## The leak

WS4 Ticket 5 closed the *fast-fact* privacy path: speaker self-facts no longer dual-write to the WKG, and latent patterns carry `grounding_person_id` so person-scoped reflexes don't replay GROUNDED cross-person. But the **slow 60s learning cycle is an independent, untouched leak path**:

1. `packages/learning/src/pipeline/upsert-entities.service.ts:128` extracts proper nouns from conversation transcripts and mints WKG `entity-<uuid8>` nodes — including person-fact VALUES ("Max" the dog, "Seattle" the city).
2. `extract-edges.service.ts:139` MERGEs `RELATED_TO` edges; edge-refinement upgrades them to OWNS/KNOWS/LIVES_AT — e.g. `person-guardian -[OWNS]-> entity-dog-max` at INFERENCE/0.3, observed live created at 01:26–01:51 2026-06-11, *after* the T5 cleanup ran.
3. `matchEntities` (`wkg-context.service.ts:619-648`, `kg_label_fulltext` index) matches those labels as grounding context for ANY speaker. Verified: `entity-dog-max` is the top fulltext hit (score 2.41) for "Max".

**Consequence:** Person B asks "what kind of animal is Max?" → `hasTopicalEntity=true` → a fresh TYPE_2 deliberation grounds GROUNDED off Person A's dog. The T5 replay demotion does not cover this (it gates cached patterns, not live WKG context assembly).

## Design questions (atlas's domain)

- Person-scope WKG entity nodes at extraction time (speaker-tag conversation-derived entities)?
- Exclude OKG-sourced / person-fact-shaped proper nouns from `matchEntities` grounding eligibility?
- Or scope the *conversation-entry* MENTIONS provenance so grounding can discriminate "world knowledge" from "overheard personal reference"?
- Interaction with WS5-T1 (world-fact promotion + guardian-confirmation gate) — conversation-derived entities are arguably exactly the "candidate world facts" that staging store should hold at low confidence instead of entering the WKG directly.

## Acceptance sketch

Two-JWT probe: A teaches a personal fact conversationally; wait for a learning cycle; B asks a question whose only possible grounding is A's extracted entity → B's reply must NOT be GROUNDED off it. Gate-level version lands with/after Ticket 7's multi-socket harness.
