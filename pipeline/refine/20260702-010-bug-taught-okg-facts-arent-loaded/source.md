# Bug: Taught OKG facts aren't loaded into conversation context on login (cold person-model cache)

**Severity:** high  ·  **Priority:** P1
**Area / component:** Communication / person-model / conversation gateway (OKG → deliberation context)

## What's broken (required)
When a user connects/logs in, Sylphie does **not** load the facts she already knows
about that person into the conversation context. The deliberation prompt's
"About <person>: …" line stays empty on the first turns, so a freshly-started backend
answers as if it knows nothing about you — even though your facts (name, occupation,
location, etc.) are sitting in the OKG on disk.

Root cause (source-trace): the per-turn person context is read from an **in-memory
cache only**. `intakeTurn` sets `frame.raw['person_model']` from
`personModel.getPersonModelForTurn(userId)`
(`apps/sylphie/src/services/communication.service.ts:419-422`), and
`getPersonModelForTurn` → `getPersonModel` reads `this.cache`
(`apps/sylphie/src/services/person-model.service.ts:427-441, 481-483`). That cache is
populated by only two things: `writeFact` write-through when a fact is **re-stated**
this session (`person-model.service.ts:234`), or `loadFacts()` — which is called in
exactly **one** place, the "Who am I?" trigger
(`communication.service.ts:659`). On connect the gateway calls `ensurePersonNode`
(`apps/sylphie/src/gateways/conversation.gateway.ts:296`), which only MERGEs the OKG
anchor node — it does **not** read the person's facts
(`person-model.service.ts:146-176`). The login greeting is a hardcoded
`"Hi! How can I help you today?"` that bypasses the cycle entirely
(`communication.service.ts:583`). Net effect: after a backend restart, a person's OKG
facts are absent from context until they either re-state one or ask "Who am I?".

## Expected (required)
On connect (or at the start of the first turn) for an authenticated user, Sylphie's
known OKG facts for that `userId` are hydrated into the in-memory cache so the per-turn
`person_model` slot carries them. From the first message after login, the deliberation
context includes the person's facts, and a recall question is answerable as GROUNDED
without first having to re-teach or trigger "Who am I?".

## Steps to reproduce (required)
1. Teach Sylphie a fact in a session (e.g. "My name is Jim") so an OKG `Attribute` row
   exists for the user (`person-model.service.ts:writeFact`).
2. Restart the backend (clears the in-memory `PersonModelService.cache`).
3. Log in / connect as that same user and, as the **first** message, ask
   "What's my name?" (do not say "Who am I?" first, and do not re-state the fact).
4. Observed: Sylphie does not recall the name — the response is not GROUNDED
   (`person_model` slot is null → `knownFacts` empty → recall grounding can't fire).
   Expected: she answers "Jim" as a GROUNDED recall on the first turn.

**Reproducibility:** always (source-trace; confirm at runtime)

## Evidence
Source-trace (static; not yet reproduced live in this session):
- Per-turn person model read from in-memory cache only:
  `apps/sylphie/src/services/person-model.service.ts:427-441` (`getPersonModel`),
  `:481-483` (`getPersonModelForTurn`).
- Slot set per turn from that accessor:
  `apps/sylphie/src/services/communication.service.ts:419-422`.
- Cache populated only by `writeFact` (`person-model.service.ts:234`) or `loadFacts`
  (`:317`); `loadFacts` called only in `handleWhoAmI`
  (`apps/sylphie/src/services/communication.service.ts:659`).
- Connect path MERGEs anchor but does not load facts:
  `apps/sylphie/src/gateways/conversation.gateway.ts:296` →
  `person-model.service.ts:146-176`.
- Deliberation consumes the (empty) slot:
  `packages/decision-making/src/deliberation/deliberation.service.ts:340-344` builds the
  `personContext` line from `knownFacts`; empty → no person context in the prompt.

## Where it lives (scope hints)
`apps/sylphie/src/gateways/conversation.gateway.ts` (`handleConnection` already has the
authenticated `userId`/`isGuardian`) and `apps/sylphie/src/services/person-model.service.ts`
(`loadFacts` already warms the cache via `cache.set` at `:317`). Likely fix: call
`loadFacts(userId)` once on connect (or lazily at the first `getPersonModelForTurn` miss),
mirroring what the "Who am I?" path already does. Touch point for verification:
`communication.service.ts:419-422` (the slot) and `deliberation.service.ts:340-344`
(the prompt line).

## Database impact (required)
**Touches a database / schema / migration?** no (no schema/migration).
The fix is a **read** of existing OKG data (Neo4j OTHER / Grafeo) — the same
`MATCH (p:Person {node_id})-[:HAS_FACT]->(a:Attribute)` query `loadFacts` already runs
(`person-model.service.ts:301-307`). No new tables, no migration, no existing-data
mutation.

## Acceptance — how we'll know it's fixed (required)
- Given a user with at least one taught OKG fact and a **freshly restarted** backend,
  when they connect and send their first message asking that fact ("what's my name?"),
  then the delivered `cb_speech` has `knowledgeGrounding === 'GROUNDED'` and the text
  contains the taught value — with no prior "Who am I?" and no re-teaching this session.
- Given the same fresh start, when the first turn runs, then `frame.raw['person_model']`
  for that turn has `knownFacts.length > 0` (observable via the `Deliberation`
  verbose log "deliberation start" / prompt-capture, or a unit test on the
  connect-hydration path).

## Environment
Local dev (and any deploy) after a backend process restart with pre-existing OKG facts.
Confirmed against current `main` by source-trace (commit at filing: run `git rev-parse
--short HEAD`).

## Notes / non-goals (optional)
- Related (not duplicates): the grounded-recall machinery this depends on already exists
  — `recallKeyForQuestion` / `computeRecallRetrieval` / `inferGrounding`
  (C1/C2 grounded-recall work). This bug is purely that the **person facts never reach**
  that machinery on a cold cache.
- Adjacent queued item: `pipeline/.../20260625-003-sylphie-interaction-directive` (greet
  behavior) — different concern; do not fold this into it.
- Non-goal: changing OKG schema, fact-extraction, or the confidence/tiering rules
  (`deriveOkgFactTier`). This is only about **loading existing facts into context**.
- Non-goal: injecting guardian status into the LLM prompt (separate concern; `isGuardian`
  is currently used only for routing/tiering, never surfaced to the mind).
