# Plan — 20260702-009: Grounded self-state answering (no-LLM drive-snapshot readout)

## Source verification (all claims confirmed against `main` @ `13a33e8`)

Every file:line claim in `source.md` was checked against the actual repo and is
**accurate**:

- `recallKeyForQuestion` (`packages/decision-making/src/deliberation/deliberation-helpers.ts:518-530`)
  maps only `name|location|dog|favorite_color|occupation` and returns `null` for
  anything else, including self-state phrasing. Confirmed.
- `inferGrounding` (`deliberation-helpers.ts:616-631`) has exactly 4 branches
  (ignorance→UNKNOWN, OKG-fact-recalled→GROUNDED, WKG-topical→GROUNDED,
  else→LLM_ASSISTED). There is no drive-state branch. Confirmed.
- `deliberation.service.ts:431-433` hardcodes `LLM_ASSISTED` whenever intent is
  `GREETING`/`EMOTION` and no OKG/WKG grounding was found — self-state questions
  (classified `EMOTION` by the monologue LLM) fall exactly into this branch.
  Confirmed (read lines 413-510 in full).
- The drive state IS injected into the monologue prompt as `How I feel: ...`
  (`deliberation.service.ts:347-350, 368`, built from `driveSnapshot.pressureVector`
  filtered `v > 0.2`) — so today's answer can be honest in content, it just can
  never be marked GROUNDED and it always costs an LLM call. Confirmed.
- Arbitration TYPE_2 fallback (`arbitration.service.ts:330-382`) is exactly what
  routes self-state questions to the LLM monologue when no procedure graduates.
  Confirmed.
- Frontend badge (`frontend/src/components/Conversation/ConversationPanel.tsx:95-178`)
  branches purely on `knowledgeGrounding` (`GROUNDED`/`LLM_ASSISTED`/`UNKNOWN`), not
  on `groundedBy` — so **no frontend code change is required**, only a verification
  test that the existing badge renders correctly once `knowledgeGrounding` is
  `GROUNDED` on a self-state turn. Confirmed.
- `IDriveStateReader.getCurrentState()` is already injected read-only into
  `decision-making.service.ts` (line 240/608) and `deliberation.service.ts` — no new
  drive-engine wiring needed, consistent with CANON drive isolation (push-only,
  read-only consumption here). Confirmed.
- **No DB/schema surface** — `DriveSnapshot` is an in-memory read via
  `IDriveStateReader`, never a store. Confirmed; source's own "no" answer to the DB
  question is correct.

One correction to the source's framing: it says GREETING/EMOTION is "hardcoded to
LLM_ASSISTED" — more precisely it's the **fallback branch** of a 4-way cascade (OKG
recall and WKG-topical grounding are checked first and win if they hit). For
self-state questions specifically this distinction doesn't matter today, because
there is no self-state source anywhere in the cascade, so EMOTION-classified
self-state turns always fall through to the LLM_ASSISTED branch. The bug is real;
just noting the precise mechanism for whoever builds this.

## Existing contract overlap

No existing epic/ticket covers self-state grounding. Adjacent/precedent work (do
not clone, but the build should mirror/reuse patterns from):
- **EP-7** ("Extract TensorCandidateBuilder + RecallRetrievalHelper") — created the
  `RecallRetrievalHelper.computeRecallRetrieval()` / pre-arbitration recall pattern
  this bug's fix should mirror.
- **WS5.5.4** ("confirm durable OKG-recall path subsumes the post-hoc regex...") and
  **TK-84** (subsumption ticket, `okg-recall-subsumption.spec.ts`) — the corpus-proof
  pattern a self-state analog should follow (regex classifier proven against a
  corpus of phrasings, non-regression proof against the existing fact set).
- **DEC-31 / AD-0048** (`applyRecallGroundingFromRetrieval` surface-check fix) — the
  most recent hardening of the exact grounding-cascade code this ticket touches;
  read before editing `recall-retrieval.ts`.

No ticket needs to reopen or duplicate any of the above; this is new scope
(`self-state` is a new grounding source, not a new fact key).

## Design forks — genuinely ambiguous, need an architect ruling (→ replan)

Investigating the fix surfaced two real architectural forks that materially change
which files a ticket touches and how big it is. The source itself flags fork 1 as
"worth raising for architect" — investigation confirms it's real, and surfaced a
second, related fork the source didn't call out.

**Fork 1 — where does the no-LLM self-state short-circuit live?**
- *Option A — TYPE_1 procedure/reflex.* Register a deterministic procedure that
  `arbitration.service.ts`'s existing TYPE_1 graduation path (lines ~280-330) can
  select, reusing the procedure/confidence-graduation machinery that already exists
  for other reflexes.
- *Option B — pre-arbitration short-circuit* (source's "Where it lives" hint,
  and this plan's recommendation). Mirror `computeRecallRetrieval()`
  (`decision-making.service.ts:652`), which today runs **once, before arbitration**,
  for every cycle. A self-state classifier hit would return a complete
  `CycleResponse` directly, bypassing `processInput`'s WKG candidate build,
  arbitration, and **all three** `deliberation.deliberate()` call sites
  (`decision-making.service.ts:1090, 1179, 1291`) for that cycle only.
- Option A reuses existing graduation/procedure infrastructure but pulls self-state
  into the procedure system (blast radius: `arbitration.service.ts`, procedure
  registration, TYPE_1 metrics/attractor-monitor which counts TYPE_1 outcomes).
  Option B is more surgical (no arbitration change) but is a **new kind of
  cycle-level early-return** that doesn't exist today — recall-retrieval today only
  *grounds text the LLM already generated*, it never skips the LLM. Confirmed by
  reading `deliberation.service.ts:413-510`: even OKG-recall grounding runs the
  monologue LLM call first, then checks whether the fact value *surfaced* in the
  LLM's own text. Neither current pattern is truly a "no LLM call" path — this bug
  requires a genuinely new control-flow shape either way.

**Fork 2 — how does the no-LLM answer get signaled/typed?**
- `degradedNoLlm` (`DeliberationResult`/`CycleResponse`, threaded end-to-end) looks
  reusable but **means the opposite thing**: confirmed at
  `deliberation.service.ts:905-943` — it is set `true` only when the LLM is
  *unavailable* (circuit breaker / Lesion Test) and Sylphie falls back to an honest
  `NO_LLM_SHRUG_TEXT` admission (`knowledgeGrounding: 'UNKNOWN'`). Self-state's
  "no LLM call" is a **success** path (`GROUNDED`, LLM never needed), not a
  degraded fallback — reusing this field would conflate two opposite states.
- `groundedBy` is a closed literal union `'OKG' | 'WKG' | null`
  (`packages/shared/src/types/communication.types.ts:178,391`), used identically in
  `recall-retrieval.ts`'s `RecallSource` type. Recording drive-snapshot provenance
  distinctly (e.g. a new `'DRIVE'` member) means widening a type consumed across
  `decision-making.service.ts` (5+ sites), `deliberation.service.ts`,
  `deliberation-helpers.ts`, and their specs — real but bounded scope. The
  alternative is to skip typed provenance and just set the existing
  `groundingProvenance?: string | null` free-text field (e.g.
  `"drive-snapshot:pressureVector"`) and leave `groundedBy` `null` — zero type
  changes, but provenance becomes untyped/unparseable for downstream consumers.

Both forks need one ruling each before the wiring ticket (009-c below) can be
built without guessing. Tickets 009-a/009-b (the classifier and the pure NLG
responder) are unaffected by either fork and can be built immediately.

## Proposed epic

**Working id `20260702-009`** — "Grounded self-state answering: drive-snapshot
readout for 'how are you' questions, no LLM call, GROUNDED provenance."
Parent: new epic (no existing parent feature fits; recommend attaching to the
same feature that owns EP-7/decision-making grounding work if one exists at
refine time, else a new small feature).

## Proposed tickets

### 20260702-009-a — Self-state question classifier
- **Title:** Add `selfStateKeyForQuestion` (or equivalent) deterministic classifier
  alongside `recallKeyForQuestion`
- **Engineering level:** production
- **Priority:** P1
- **Depends on:** none — buildable immediately, no fork blocking it
- **Non-goals:** classifying anything beyond "how are you / how do you feel /
  what's your mood / how are you doing / how are you feeling"; touching
  `recallKeyForQuestion` itself; any embedding/semantic matching (regex only, same
  style as the existing classifier).
- **Acceptance criteria:**
  - Given inputs `["how are you?", "how are you doing?", "how do you feel?",
    "how are you feeling?", "what's your mood?"]`, when the classifier runs, then
    it returns a non-null/true self-state discriminator for every one.
    **Runnable check:** new `describe('selfStateKeyForQuestion')` block in
    `packages/decision-making/src/deliberation/deliberation-helpers.spec.ts`
    (parametrized, mirroring the existing `recallKeyForQuestion` describe block at
    line ~90), run via `yarn jest deliberation-helpers.spec.ts` from
    `packages/decision-making`.
  - Given inputs `["what is my name?", "where do I live?", "what do I do for
    work?", "hi there", "tell me a story"]`, when the classifier runs, then it
    returns null/false for every one (no false-positive collision with fact-recall
    or plain greetings). **Runnable check:** same spec file, same command.

### 20260702-009-b — Deterministic self-state responder (pure NLG, no LLM)
- **Title:** Build a pure function that renders self-state text from
  `DriveSnapshot.pressureVector`, mirroring the existing prompt-injection filter
- **Engineering level:** production
- **Priority:** P1
- **Depends on:** none
- **Non-goals:** tone/personality variety knobs; anything that writes to or
  recomputes the drive engine (CANON drive isolation — read-only consumer of the
  snapshot already injected via `IDriveStateReader`).
- **Acceptance criteria:**
  - Given a `pressureVector` with one entry (e.g. `Curiosity`) `> 0.2` and all
    others `<= 0.2` (mirroring the existing threshold at
    `deliberation.service.ts:348`), when the responder runs, then the output text
    references the qualifying drive and does not name any drive at or below the
    floor. **Runnable check:** new unit spec (e.g.
    `self-state-responder.spec.ts`) asserting the qualifying drive name appears and
    the suppressed ones do not; run via `yarn jest self-state-responder`.
  - Given a `pressureVector` with every entry `<= 0.2` (flat/baseline), when the
    responder runs, then the output is a calm/neutral statement that does **not**
    fabricate a specific named emotion absent from the snapshot (CANON Std-1
    Theater Prohibition). **Runnable check:** same spec, assert no drive-name
    token appears in a flat-state case and the text matches an allow-listed neutral
    template/regex.

### 20260702-009-c — Wire the no-LLM short-circuit into the cognition cycle
- **Status:** **BLOCKED on architect ruling for Fork 1 and Fork 2 above.** Do not
  build until both are resolved — the call site, the control-flow shape, and the
  provenance typing all depend on the ruling.
- **Title:** Short-circuit self-state questions to a GROUNDED, no-LLM
  `CycleResponse` before/instead of `deliberate()`
- **Engineering level:** production
- **Priority:** P1
- **Depends on:** 20260702-009-a, 20260702-009-b, architect ruling (Fork 1, Fork 2)
- **Non-goals:** changing `arbitration.service.ts` graduation thresholds or TYPE_1
  metrics unless the ruling picks Option A; touching the drive engine; changing
  GREETING/EMOTION handling for genuine social chit-chat (source's explicit
  non-goal); re-routing general conversation away from the LLM.
- **Acceptance criteria** (recommended default shape — Option B; adjust call site
  per ruling, ACs stay the same):
  - Given the drives in a known, non-trivial state and a self-state question
    ("how are you doing?"), when a cognition cycle runs end-to-end, then the
    delivered `CycleResponse`/`cb_speech` has `knowledgeGrounding === 'GROUNDED'`
    and the response text correlates with the actual dominant `pressureVector`
    entries (reuses 009-b's responder, so this is non-fabrication by construction).
    **Runnable check:** new integration spec (e.g. `self-state-grounding.spec.ts`)
    constructing a fake `IDriveStateReader` with an elevated-Curiosity snapshot,
    driving one cycle, asserting `knowledgeGrounding === 'GROUNDED'` and the
    response text contains the expected drive reference.
  - Given the same setup, when the cycle runs, then the mocked/spied LLM
    completion entrypoint (`ILlmService.complete`) is called **zero times** for
    that cycle. **Runnable check:** same spec, `expect(llmSpy).not.toHaveBeenCalled()`.
  - Given a plain greeting with no self-state question ("hi there"), when the
    cycle runs, then behavior is unchanged from today — the existing
    GREETING/EMOTION LLM monologue path still executes and the LLM spy **is**
    called at least once. **Runnable check:** same spec, regression case.
  - Given the existing OKG fact-recall corpus (questions `recallKeyForQuestion`
    matches: name/location/dog/favorite_color/occupation), when the cycle runs,
    then behavior for those questions is unchanged (the new classifier must not
    shadow fact-recall — the two classifiers must be mutually exclusive on the
    existing corpus). **Runnable check:** re-run the existing
    `okg-recall-subsumption.spec.ts` and `recall-retrieval.spec.ts` suites green
    with zero regressions, via `yarn jest okg-recall-subsumption recall-retrieval`.

### 20260702-009-d — Frontend badge verification (no code change expected)
- **Title:** Prove the existing GROUNDED badge renders correctly for a self-state
  turn — verification only
- **Engineering level:** prototype (test-only; no production code change expected)
- **Priority:** P2 (verification, no functional risk — confirmed
  `ConversationPanel.tsx` branches only on `knowledgeGrounding`, not `groundedBy`,
  so no frontend code change is anticipated)
- **Depends on:** 20260702-009-c
- **Non-goals:** any `ConversationPanel.tsx` code changes; if this ticket
  discovers a real gap, it should be re-scoped, not silently expanded.
- **Acceptance criteria:**
  - Given a message with `knowledgeGrounding: 'GROUNDED'` produced by a self-state
    turn, when `ConversationPanel` renders it, then the "from memory" chip is shown
    and the "Sylphie speaks" caption path is used (existing behavior, asserted, not
    changed). **Runnable check:** new or existing React Testing Library component
    test under `frontend/src/components/Conversation/` asserting the chip text
    renders for a `GROUNDED` message; run via the frontend package's `yarn test`
    script.

## Split recommendation

None. The item is cohesive — one bug, one missing grounding source. 009-d is
small and could in principle be dropped if the reviewer is satisfied by static
inspection alone, but it's cheap enough to keep as a real regression proof rather
than an assumption.

## Routing recommendation: **replan**

Forks 1 and 2 above are genuine architecture questions this plan cannot guess
past — CLAUDE.md's escalation rule ("hard questions → architect... don't grind on
it yourself") and the pipeline rule ("ambiguity routes to replan with the question
written down — never guessed") both point here. Tickets 009-a and 009-b are
unaffected by either fork and are ready to build as-is; 009-c is staged but
explicitly blocked pending the ruling; 009-d follows 009-c.
