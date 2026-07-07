# Plan — 20260702-010: Taught OKG facts aren't loaded into conversation context on login (cold person-model cache)

## Source verification (against current `main`)

Every line-level claim in `source.md` was checked against the actual files and is
**accurate**:

| Claim | File:line | Verified |
|---|---|---|
| `intakeTurn` sets `person_model` slot from `getPersonModelForTurn(userId)` | `apps/sylphie/src/services/communication.service.ts:419-422` | Confirmed verbatim (`this.tickSampler.update('person_model', this.personModel.getPersonModelForTurn(userId))`) |
| `getPersonModel`/`getPersonModelForTurn` read only `this.cache` | `apps/sylphie/src/services/person-model.service.ts:427-441` (`getPersonModel`), `:481-483` (`getPersonModelForTurn`) | Confirmed — `getPersonModel` reads `this.cache.get(personId)` only; `getPersonModelForTurn` is a one-line delegate |
| Cache populated only by `writeFact` write-through or `loadFacts()` | `person-model.service.ts:234` (`this.cache.set(userId, cached)` inside `writeFact`), `:317` (`this.cache.set(userId, facts)` inside `loadFacts`) | Confirmed, both are the only `cache.set` call sites |
| `loadFacts` is called in exactly one place: the "Who am I?" trigger | `communication.service.ts:659` (`handleWhoAmI`) | Confirmed — no other call site of `loadFacts` exists in `apps/sylphie/src` |
| `ensurePersonNode` on connect only MERGEs the anchor, never reads facts | `apps/sylphie/src/gateways/conversation.gateway.ts:296` → `person-model.service.ts:146-176` | Confirmed — the Cypher is a bare `MERGE (p:Person {...})`, no `HAS_FACT` traversal |
| Login greeting is a hardcoded string that bypasses the cycle | `communication.service.ts:583` (`greetText = 'Hi! How can I help you today?'`) inside `initiateConnectionGreet` | Confirmed — this is TK-100 (done, EP-20), a synthetic `CycleResponse` with no LLM call and no person-model read |
| Deliberation builds `personContext` from `knownFacts`; empty → no person context | `packages/decision-making/src/deliberation/deliberation.service.ts:340-344` | Confirmed verbatim |

**Root cause confirmed exactly as filed**: on a cold cache (fresh backend process), the
window between WS connect and the user's first message never calls `loadFacts`, so the
per-turn `person_model` slot is `null` until the user either re-states a fact (write-through)
or explicitly asks "Who am I?" (the only `loadFacts` call site).

One nuance the source didn't need to resolve but the fix does: **TK-100's greet-on-connect
does NOT read facts either** (it's a synthetic, non-LLM `CycleResponse`) — so hydrating at
greet time would be a no-op distraction; the fix must hydrate at *connect* time and the
hydration must be provably complete before the *first real turn's* synchronous cache read,
not just "usually fast enough." `intakeTurn`'s cache read
(`communication.service.ts:419-422`) is synchronous and is called from
`conversation.gateway.ts:420`, which itself only runs after an async continuation
(`handleTriggerPhrase(...).then(...)`, `conversation.gateway.ts:394-422`) — that continuation
is the one existing async seam available to await hydration on before the sync read happens,
without changing `intakeTurn`'s signature.

## Existing contract overlap

Searched `planning/contract.yaml` (read-only) for `person_model`, `person-model`,
`ensurePersonNode`, `loadFacts`, `hydrat`, `OKG fact`, `handleConnection`,
`conversation.gateway`, and grounded-recall keywords (`GROUNDED`, `recallKeyForQuestion`,
`computeRecallRetrieval`, `inferGrounding`).

**No existing ticket covers this bug.** Adjacent-but-distinct work found (do not attach to,
per source.md's own non-goal note):
- **TK-100** (`EP-20`, done) — "Greet-first on connect." Confirmed it is a *different* greet
  path: a hardcoded, non-LLM synthetic `CycleResponse` that never touches
  `PersonModelService`. Adjacent, not overlapping.
- **TK-95** (`EP-19`, done) — Neo4j\[other\]/OKG *connectivity* restore (URI/env fix). Different
  failure mode (connection-level 500s), not the cache-hydration timing bug. Not overlapping.
- Several grounded-recall tickets (`recallKeyForQuestion`/`computeRecallRetrieval`/
  `inferGrounding` refactors under earlier epics, all `done`) — these are the machinery this
  bug's fix *feeds into*; none of them touch the connect-time hydration gap.

**Recommended attach point**: a new small epic under `FEAT-2` (the communication/conversation
feature bucket that already owns TK-95/97-106/EP-19/EP-20 — all done, all person-model/comms
bug-fix epics of this same shape). Next free epic id at time of this plan is `EP-28` (highest
existing is `EP-27`); **confirm still free at refine/queue time** since other pipeline items
may claim ids first. Proposed: `EP-28` — "Person-model cold-cache hydration on connect."

`existing_contract_overlap`: none (new epic/tickets recommended).

## Proposed tickets

### 20260702-010-a — Hydration primitives on `PersonModelService`

**Proposed contract id:** `TK-NEW-1` (parent `EP-28`)
**Priority:** P1 (correctness bug, no data loss/security angle — per source's own severity)
**Engineering level:** production (live conversation-context path; guardian-tiering-adjacent code)
**Depends on:** none

**Title:** Add connect-time hydration + a race-safe await primitive to `PersonModelService`

**Scope:** Add two methods to `apps/sylphie/src/services/person-model.service.ts`:
- `hydrateOnConnect(userId: string): void` — fire-and-forget kickoff of `loadFacts(userId)`
  (reuses the existing read-only Cypher at `:301-307`, no new query), tracking the in-flight
  promise in a private `Map<string, Promise<void>>` so concurrent callers can observe it, and
  clearing the entry once it settles (success or failure — never leave a stale in-flight
  marker that hangs subsequent turns forever).
- `awaitHydration(userId: string): Promise<void>` — resolves immediately if no hydration is
  in flight for that `userId` (e.g. guest/anonymous, or hydration already settled); otherwise
  awaits the tracked promise.

**Non-goals:**
- No change to `loadFacts`, `writeFact`, `getPersonModel`, `getPersonModelForTurn`, or the
  Cypher queries themselves.
- No change to fact confidence/provenance/tiering (`deriveOkgFactTier`) — CANON confidence
  ceiling and guardian asymmetry are untouched.
- No change to the "Who am I?" trigger path.

**Acceptance criteria (Given/When/Then, each with a runnable check):**

1. Given a cold cache for `userId` and a mocked Neo4j session returning N facts, when
   `hydrateOnConnect(userId)` is called and its tracked promise settles, then
   `getPersonModel(userId)!.knownFacts.length === N`.
   **Runnable check:** new spec `apps/sylphie/src/services/person-model-hydration.spec.ts`
   (standalone `node:assert` harness with a mocked Neo4j session, mirroring the existing
   `communication.cost.spec.ts` / `communication-floor-wiring.spec.ts` pattern — no live DB),
   run via `npx tsx apps/sylphie/src/services/person-model-hydration.spec.ts`.
2. Given `hydrateOnConnect(userId)` was called with a mock session whose query resolution is
   held open (controlled via a manually-resolved promise in the test), when
   `awaitHydration(userId)` is awaited, then it does **not** resolve until the underlying
   query resolves, and a `getPersonModel(userId)` call made immediately after the `await`
   returns the hydrated facts — proving the race is closed by ordering, not by assuming the
   query is "fast enough."
   **Runnable check:** same spec file, dedicated case using a controlled/delayed mock.
3. Given `awaitHydration(userId)` is called for a `userId` that was never passed to
   `hydrateOnConnect` (e.g. anonymous/guest), when it resolves, then it resolves immediately
   with no throw and no hang.
   **Runnable check:** same spec file, dedicated case.
4. Given `hydrateOnConnect(userId)`'s underlying `loadFacts` call rejects or logs a warning
   (Neo4j unavailable — the existing catch-and-return-`[]` behavior at `:320-322`), when
   `awaitHydration(userId)` is subsequently awaited, then it resolves (never rejects, never
   hangs) so a Neo4j outage cannot stall every subsequent turn for that user.
   **Runnable check:** same spec file, dedicated case with a mock session that rejects.

**CANON:** No impact. Pure read-timing/ordering primitive around the existing `loadFacts`
read path; touches no confidence, provenance, drive, or guardian-tiering logic.

---

### 20260702-010-b — Wire hydration into connect + close the first-turn race

**Proposed contract id:** `TK-NEW-2` (parent `EP-28`)
**Priority:** P1
**Engineering level:** production
**Depends on:** `20260702-010-a` (needs `hydrateOnConnect`/`awaitHydration` to exist)

**Title:** Call hydration on WS connect and await it before the first turn's person-model read

**Scope:** In `apps/sylphie/src/gateways/conversation.gateway.ts`:
- `handleConnection`: immediately after the existing
  `void this.personModel.ensurePersonNode(user.userId, user.username, user.isGuardian);`
  (`:296`), add `this.personModel.hydrateOnConnect(user.userId);` (same fire-and-forget style
  as the existing call — no new await pattern needed here).
- The message handler's async continuation (`handleTriggerPhrase(...).then((handled) => {
  ... })`, `:394-422`): before the `intakeTurn(...)` call at `:420`, `await
  this.personModel.awaitHydration(userId)` so `intakeTurn`'s synchronous
  `getPersonModelForTurn(userId)` read (`communication.service.ts:419-422`) is guaranteed to
  run after any connect-time hydration for that user has settled — closing the race
  regardless of how fast the first message arrives after connect.

**Non-goals:**
- No change to `intakeTurn`'s signature or its synchronous cache-read contract.
- No change to the greet-on-connect content or timing (TK-100, done, out of scope).
- No change to `handleTriggerPhrase`/"Who am I?" behavior beyond the hydration wiring being
  present underneath it (it already calls `loadFacts` directly and is unaffected).
- No change to OKG schema, fact-extraction, or `deriveOkgFactTier` tiering rules (source's own
  non-goal, carried forward).
- No change to surfacing `isGuardian` to the LLM prompt (source's own non-goal, carried
  forward — separate concern).

**Acceptance criteria (Given/When/Then, each with a runnable check):**

1. Given a user with >=1 taught OKG fact and a cold `PersonModelService` cache (simulating a
   fresh backend restart), when the connect path runs (`ensurePersonNode` +
   `hydrateOnConnect`) and then, with no prior "Who am I?" and no re-teaching, the first
   message's intake continuation runs (`awaitHydration` then `intakeTurn`), then the
   `person_model` tickSampler slot passed into that turn has `knownFacts.length > 0` and
   contains the taught fact.
   **Runnable check:** new wiring-level spec
   `apps/sylphie/src/gateways/conversation-gateway.hydration-wiring.spec.ts`, mirroring
   `communication-floor-wiring.spec.ts`'s approach (re-exercises the exact
   connect → hydrate → await → intake ordering with mocked `PersonModelService`/
   `CommunicationService.intakeTurn`, no live NestJS bootstrap, no live DB) — run via
   `npx tsx apps/sylphie/src/gateways/conversation-gateway.hydration-wiring.spec.ts`.
2. Given the same cold-cache setup, when the mock hydration query is deliberately held open
   past the moment the synthetic "first message" event fires, then `intakeTurn` (the mock)
   is observed to be called only **after** the hydration promise settles, never before —
   proving the fix is race-closing under an adversarial timing, not merely "usually wins the
   race."
   **Runnable check:** same spec file, dedicated case.
3. Given the full acceptance scenario from `source.md` (fact taught → restart → connect →
   first message "what's my name?" with no "Who am I?" first) exercised at the
   `CommunicationService` level with a real (in-process, non-live-DB) `PersonModelService`
   backed by a mocked Neo4j session seeded with one `name` fact, when `intakeTurn` runs for
   that first message, then the resulting `frame.raw['person_model']` (`tickSampler`'s
   `person_model` slot) has `knownFacts` containing `"name: Jim"` (or the seeded value) —
   this is the direct regression check for the bug as filed.
   **Runnable check:** same spec file (or a co-located `communication.person-model-hydration.spec.ts`
   if the harness is cleaner split out), run via `npx tsx <path>`.
4. Given the connect path for an **anonymous** (no `user`) connection, when `handleConnection`
   runs, then `hydrateOnConnect` is never called (matches the existing `if (user) { ... }`
   guard already present around `ensurePersonNode`/greet scheduling at `:282-321`) — no
   regression for the anonymous-connection path.
   **Runnable check:** same spec file, dedicated case (assert the mock `hydrateOnConnect` is
   not invoked when `user` is undefined).

**CANON:** No impact — same read path as -a, only the call sites and ordering change. Does
not touch drive isolation, provenance, confidence ceiling, theater, guardian asymmetry, or
the evaluation function.

**Note on live verification (not a ticket AC, but required before this is called "done" per
repo convention):** the automated specs above prove correctness deterministically without a
live backend/DB. Before closing this out, also run the literal repro from `source.md` against
a real dev backend (teach a fact, restart, reconnect, ask "what's my name?" as the first
message) and confirm `knowledgeGrounding === 'GROUNDED'` in the live `cb_speech` — this is the
"verify before presenting" repo rule, distinct from the unit-level runnable checks above.

## Split recommendation

None. The item is a single, well-scoped bug with one coherent fix; the two tickets above are
a vertical dependency chain (primitives, then wiring + regression proof), not unrelated
concerns. `source.md` itself already correctly excludes the adjacent greet-behavior item
(`20260625-003`) — that exclusion is preserved as a non-goal on ticket -b, not re-litigated
here.

## Open questions

None requiring an architect/Jim ruling. The fix stays within existing patterns (a promise
tracked in a `Map`, awaited from the one existing async seam in the message-handling path) —
no design fork, no CANON conflict, no DB surface.

## DB gate

See `migration.md` in this folder — **n/a**. Confirmed by reading `loadFacts`
(`person-model.service.ts:292-326`): the fix reuses the existing read-only
`MATCH (p:Person)-[:HAS_FACT]->(a:Attribute)` query verbatim. No new tables, indexes,
constraints, or data mutation; only in-memory (`Map`) bookkeeping and call-site/ordering
changes in TypeScript.

## Routing recommendation

**refine** — the plan is clean, atomic, and fully verified against source. No design fork,
no CANON conflict, no ambiguity requiring architect/Jim.
