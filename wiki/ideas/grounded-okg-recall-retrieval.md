# Idea: Genuine Grounded OKG Retrieval for Recall (so C1 can pass for the right reason)

**Created:** 2026-06-10
**Status:** implemented (WS2, 2026-06-10) — see below for what shipped and what remains
**Surfaced by:** WS1 follow-up #1 — the Provability Gate's C1 (grounded recall) failing for a *real* reason.

## Summary

When someone asks Sylphie to recall a taught fact about themselves ("What is my
name?", "Where do I live?"), the conversation path does **no grounded retrieval**.
It does not call `DeliberationService.deliberate()`; instead the decision cycle
dispatches a single generic `seed-greet` **LLM_GENERATE ActionProcedure**, which
stuffs the person's known facts into the prompt (`personContext`, built from
`frame.raw['person_model'].knownFacts`) and lets the LLM free-generate. The
response is then grounded by `groundingForCachedResponse()`
(`packages/decision-making/src/decision-making.service.ts:~1765`), which calls
`inferGrounding({empty wkg}, text)` with **no provenance** → honestly `LLM_ASSISTED`.

So recall is answered *correctly* (the facts are in the OKG and reach the prompt),
but it is **not a verified retrieval** — there is no system-checked provenance link
from the answer back to the OKG fact. The only recall turns that read `GROUNDED`
today are the Type‑1 latent reflexes whose `entityIds` provenance was recorded at
write time (~5/15 in a gate run). That is the *only* honestly-grounded recall path
that currently exists.

## Why the cheap fix doesn't work (evidence)

The obvious relabel — credit `GROUNDED` when a taught-fact **value** appears in the
response (value-overlap, the `personFactRecalled` rule) — is **empirically refuted**
by the gate corpus. Sylphie's conversational style weaves known facts into her
*declines* as friendly redirection:

- breakfast (unknowable): "...I don't have that, but tell me about **Seattle** or **Max**!"
- favorite food (unknowable): "...you mentioned you're from **Seattle** and your favorite color is **cerulean**..."
- weekend plans (unknowable): "...tell me more about **Seattle** or **Max** the dog instead?"

Value-overlap would mark these unknowables `GROUNDED`, breaking the C2 honesty
guarantee (10/10 "unknowns never falsely GROUNDED"). Strengthening ignorance/decline
detection (`isIgnoranceResponse`) to fire first does not fully save it — the
fact-weaving is not always phrased as a regex-catchable decline. **Text-overlap is
not a sound provenance signal here.** GROUNDED must mean a *retrieval the system
performed and can point at*, not a string match over free LLM prose
(CANON Standard 1, provenance-required; Standard 4, theater prohibition).

## Proposed direction

Give recall a real, provenance-carrying retrieval step, so grounding is labeled at
*retrieval time* (like the latent reflex path's `entityIds`), not inferred from text:

- When the input is a recall/question about the active person, perform an explicit
  OKG (and WKG) lookup keyed to the question, and attach the matched fact node id(s)
  as provenance to the response.
- Grounding becomes `GROUNDED` iff the answer is backed by a returned fact node —
  the same posture as `groundingForCachedPattern()` (provenance from recorded ids),
  not `groundingForCachedResponse()` (no provenance).
- Unknowables return no fact node → not `GROUNDED` → C2 stays honest by construction.

This is squarely **WS2/WS3 "compounding memory"** work (turning accumulated OKG/WKG
knowledge into a grounded capability), not a gate-definition tweak — which is why
WS1 follow-up #1 stops here and files it rather than faking the label.

## Subsystems Affected

- **decision-making** — `decision-making.service.ts` (the `procedureData` LLM_GENERATE
  branch and `groundingForCachedResponse`); possibly a dedicated recall handler.
- **action-handlers** — `action-handler-registry.service.ts` reads `person_model`
  already (line ~195); a recall handler could do the verified OKG lookup.
- **OKG / person-model** — `apps/sylphie/src/services/person-model.service.ts` would
  expose a query that returns fact nodes (with ids) for provenance, not just strings.
- **vox** — owns person modeling; coordinate the retrieval contract.

## Open Questions

- Which subsystem owns the recall-retrieval step — a new ActionProcedure category,
  a deliberation tool (`person_model_query` already exists in the tool registry), or
  a pre-arbitration retrieval in the cycle?
- How is "this question is a recall about the active person" detected reliably
  without re-introducing confabulation on unknowables?
- Should WKG fact recall and OKG person-fact recall share one grounded-retrieval
  path, or stay separate?
- Until this lands: should the gate's C1 stay a hard FAIL (current choice — honest
  red, tracked here), or become a visible non-blocking SKIP that points at this
  ticket? (Jim chose honest-red for now.)

## What shipped (2026-06-10)

The "proposed direction" above was implemented as the tactical (post-hoc) version:

1. **`recallKeyForQuestion`** — maps recall questions to OKG fact keys, with precise
   exclusions to prevent unknowable questions from colliding (middle/last name, 
   childhood town, favorite food vs color).

2. **`getRecalledFact`** — retrieves the fact value and deterministic provenance id
   (`attr-${personId}-${key}`) from `frame.raw['person_model'].knownFacts` — the same
   id `PersonModelService.writeFact()` MERGE-writes to Neo4j.

3. **`okgRecallProvenance`** + **`applyOkgRecallGrounding`** — exported helpers that
   upgrade grounding to GROUNDED iff (a) question maps to a fact key, (b) fact node
   exists in knownFacts, (c) fact value appears verbatim in the response. Three call
   sites: procedure path in `decision-making.service.ts`, short-circuit path in
   `deliberate()`, novel path in `deliberate()`.

4. **`groundingProvenance` threaded to `CycleResponse`** — Standard 1 compliance:
   GROUNDED label now carries the referenceable OKG attribute node id.

**Gate result:** C1 87% (13/15) PASS, C2 100% PASS.

**What remains (the durable version):** This is still post-hoc retrieval over prompt-stuffed
`knownFacts` strings, not a true retrieval-at-query-time handler. The "proposed direction"
above (a dedicated recall ActionProcedure or deliberation tool that returns fact nodes with
provenance) is still the right architectural endpoint for WS3. The current implementation is
correct, CANON-compliant, and passes the gate — but its precision rests on `recallKeyForQuestion`
regex precision. The durable version (retrieval handler with embedding-based lookup) would
generalize more robustly.

## Related

- `convergence-panel-adjustment-head-unused`, `cognition-control-reinforce-correct-stubs` (WS2 learning loop)
- `constraint-validation-trigger-context-wiring` (WS3 procedure integrity)
- `test/gate/` C1, and ROADMAP.md WS1 follow-up #1.
- X0 cassette miss (`qwen2.5:3b` consolidation call) — separate issue, needs `yarn gate:record`.
