# Bug: Self-state questions ("how are you?") are answered as an LLM guess, not grounded in actual drive state

**Severity:** medium  ·  **Priority:** P1
**Area / component:** decision-making (deliberation + grounding) / Communication voice

## What's broken (required)
Basic questions about Sylphie's own state — "how are you?", "how do you feel?" — are
routed to the LLM (TYPE_2 deliberation) and then **hardcoded to `LLM_ASSISTED`**, so the
UI badges them "Sylphie guesses (tool-assisted)". They are treated as ungrounded social
chit-chat, even though Sylphie's live `DriveSnapshot` is the single most ground-truth
object in the system (it IS her actual state, per CANON Std-1). Two problems fall out:
(1) every such question burns at least one LLM call to phrase a state already known
deterministically, and (2) the answer is labeled a guess rather than GROUNDED.

Root cause (source-trace): there is **no grounded self-state path**.
- The deterministic pre-arbitration recall classifier only maps **fact** questions
  (name / location / dog / favorite_color / occupation) — it returns `null` for
  self-state questions
  (`packages/decision-making/src/deliberation/deliberation-helpers.ts:518-530`,
  `recallKeyForQuestion`).
- The grounding model treats `GROUNDED` as *only* OKG-fact-recall or topical-WKG;
  **drive state is not a grounding source at all**
  (`deliberation-helpers.ts:616-631`, `inferGrounding`).
- The deliberation short-circuit explicitly stamps `GREETING`/`EMOTION` intents as
  `LLM_ASSISTED`
  (`packages/decision-making/src/deliberation/deliberation.service.ts:431-433`).
- The real drive state *is* injected into the prompt as "How I feel: …"
  (`deliberation.service.ts:347-350, 368`), so the answer can reflect the true state —
  but it still costs an LLM round-trip and can never be marked GROUNDED.

## Expected (required)
A question about Sylphie's own internal state is recognized deterministically (the
self-state analog of the existing fact-recall classifier), answered **directly from the
live `DriveSnapshot`** without requiring an LLM call, and labeled `GROUNDED` (its
provenance is the drive snapshot itself). The answer must correlate with the actual
`pressureVector` — no fabricated mood (CANON Std-1 Theater Prohibition). General
conversation (greetings, small talk) is out of scope and stays on its current path.

## Steps to reproduce (required)
1. Bring the backend up with the drives in a known, non-trivial state (e.g. Curiosity
   elevated).
2. In the chat, send "how are you doing?" (or "how do you feel?").
3. Observed: arbitration falls through to TYPE_2 (no graduated context-matched reflex —
   `packages/decision-making/src/arbitration/arbitration.service.ts:330-382`), the
   deliberation classifies it GREETING/EMOTION and returns `knowledgeGrounding =
   'LLM_ASSISTED'` (`deliberation.service.ts:431-433`); the reply is badged
   "Sylphie guesses (tool-assisted)" in the UI
   (`frontend/src/components/Conversation/ConversationPanel.tsx:108-113, 162-169`).
   Expected: a GROUNDED, drive-state-derived answer (ideally with no LLM call).

**Reproducibility:** always (source-trace; confirm at runtime)

## Evidence
Source-trace (static; not yet reproduced live in this session):
- Recall classifier is fact-only, returns null for self-state:
  `packages/decision-making/src/deliberation/deliberation-helpers.ts:518-530`.
- Grounding ladder has no drive-state source:
  `deliberation-helpers.ts:616-631` (`inferGrounding`).
- GREETING/EMOTION hardcoded to LLM_ASSISTED:
  `packages/decision-making/src/deliberation/deliberation.service.ts:431-433`.
- Drive state IS in the prompt (so the content can be honest) but verdict is still a guess:
  `deliberation.service.ts:347-350, 368`.
- Routing to TYPE_2 (LLM) when no graduated reflex clears the context floor (0.55):
  `packages/decision-making/src/arbitration/arbitration.service.ts:85, 330-382`.
- UI "guesses" badge for LLM_ASSISTED:
  `frontend/src/components/Conversation/ConversationPanel.tsx:108-113, 162-169`.

## Where it lives (scope hints)
Mirror the existing fact-recall path for self-state:
- `packages/decision-making/src/deliberation/deliberation-helpers.ts` — add a self-state
  question classifier alongside `recallKeyForQuestion`.
- `packages/decision-making/src/deliberation/recall-retrieval.ts` /
  `packages/decision-making/src/decision-making.service.ts:~641-660` — where
  pre-arbitration recall retrieval resolves a grounded node; the self-state path would
  resolve to the `DriveSnapshot` as provenance and emit a GROUNDED, no-LLM answer
  (TYPE_1-style), analogous to `computeRecallRetrieval`.
- Drive readout is available read-only via `IDriveStateReader.getCurrentState()`
  (already in scope in `decision-making.service.ts` and `deliberation.service.ts`).

## Database impact (required)
**Touches a database / schema / migration?** no.
Purely code. The `DriveSnapshot` is read in-memory from `IDriveStateReader`
(CANON drive-isolation: read-only, no write into the drive engine). No store, schema, or
migration involved.

## Acceptance — how we'll know it's fixed (required)
- Given the drives in a known state, when the user asks "how are you?" / "how do you
  feel?", then the delivered `cb_speech` has `knowledgeGrounding === 'GROUNDED'` and the
  text correlates with the actual dominant drive(s) in `pressureVector` (Std-1: no mood
  not present in the snapshot).
- Given the same, when answered, then the self-state path requires **no LLM call**
  (`llmCalled === false` on the delivery, or an equivalent assertion that deliberation
  did not run) — proving it's a grounded readout, not a TYPE_2 guess.
- Given a normal greeting with no self-state question ("hi there"), when handled, then
  behavior is unchanged (the self-state path does not capture general conversation).

## Environment
Local dev (and any deploy). Confirmed against current `main` by source-trace
(commit at filing: run `git rev-parse --short HEAD`).

## Notes / non-goals (optional)
- This is the **self-state analog** of the existing OKG fact-recall grounding
  (C1/C2 grounded-recall work): facts already have `recallKeyForQuestion` +
  `computeRecallRetrieval` + provenance; self-state has nothing equivalent.
- Theater Prohibition (CANON Std-1) is load-bearing here: the answer must be derived from
  the real `DriveSnapshot`, never a pleasant-sounding fabrication. Consider how the
  drive snapshot serves as the provenance for the GROUNDED verdict.
- Non-goal: re-routing all conversation away from the LLM. Scope is self-state questions
  only ("how are you / how do you feel / what's your mood").
- Non-goal: changing the drive engine, drive computation, or the evaluation function
  (read-only consumption of `DriveSnapshot` only).
- Related design question worth raising for `architect`: whether self-state grounding
  should be a TYPE_1 reflex emitted before deliberation, vs. a deterministic short-circuit
  inside the monologue path.
