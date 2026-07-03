# Feature: Feeling verbalizer — deterministic drive→natural-language self-state with disclosure gating

From Jim, 2026-07-02. Companion to (and should ATTACH to / extend, not clone) pipeline
item **20260702-009** ("Self-state questions answered as LLM guess, not grounded in
actual drive state"), which is still in planning with no plan.md. Item 009 owns the
*grounding* half; this item owns the *rendering and disclosure* half. Plan them together.

## The problem

Two observed symptoms, one root cause:

1. Asking Sylphie "how are you?" returns a robotic readout of her internal readings.
2. Root cause (verified in source): drive state is injected into every response-generation
   prompt as raw numbers — `How I feel: Curiosity: 0.45, Anxiety: 0.62` — at
   `packages/decision-making/src/deliberation/deliberation.service.ts:347-350` (injected at
   lines 368, 549, 667, 733) and duplicated at
   `packages/decision-making/src/action-handlers/action-handler-registry.service.ts:224-228`.
   The LLM parrots its own telemetry because raw floats are the only self-representation
   it is ever shown.

## What Jim wants (verbatim intent)

> "Create an algorithm that outputs a complicated string of text. Like computes the drives
> and comes up with a natural language way of saying how she feels. This would be injected
> into the context instead so the how-are-you response isn't read like a robot."
>
> "Disclosure would be calculated into the mechanism I just described — the computation
> that returns the information she feels and what she is willing to share."

## Mechanism

A **deterministic algorithm** (no LLM call) — call it the feeling verbalizer — that maps
the live `DriveSnapshot` to natural language:

- **Input:** `pressureVector` (and, if cheaply available, recent trend per drive —
  rising/falling/settling — which makes phrasing far more natural), plus disclosure
  context: aggregate pressure, person-model/trust for the current speaker, `isGuardian`.
- **Output (structured):** something like
  `{ felt: string, shareable: string, disclosureLevel: <band> }` —
  - `felt`: the full honest natural-language self-description (qualitative bands, dominant
    drives, combinations, trend words — e.g. "curiosity is high and still climbing; a
    little anxious"). Used for HER OWN context (prompt injection).
  - `shareable`: the disclosure-gated version — what she is willing to say out loud to
    THIS person right now.
- **Disclosure model (the human pattern):** low pressure everywhere → minimal disclosure
  ("doing fine") even when asked directly. One drive elevated → that drive, and only that,
  surfaces. Very high aggregate pressure → deeper disclosure / oversharing. Trust and
  guardian asymmetry (×2/×3) scale depth: she tells the guardian more than a stranger.
  Selective disclosure is not deception — what she says must still correlate with the real
  `pressureVector` (Theater Prohibition, same criterion item 009 already carries); pressure
  gates only HOW MUCH surfaces.

## Wiring

1. Replace the raw-number `driveLines` injection at both sites above with the verbalizer's
   output (the `felt`/`shareable` split as appropriate for the prompt's purpose).
2. Reconcile with item 009: 009 plans a deterministic no-LLM answer path for self-state
   questions. The verbalizer's `shareable` string IS the natural deterministic answer text
   for that path — one algorithm serves both 009's grounded answer and the general-context
   injection. Do not build two separate drive→text renderings.
3. Vary phrasing across invocations at equal state (seeded rotation of synonym templates or
   similar) so repeated "how are you" doesn't return byte-identical strings and collide with
   the TK-104 content-dedup gate.

## Acceptance criteria (sketch — planning to firm up)

- Given a known `pressureVector`, the verbalizer returns a natural-language string with NO
  numeric values, whose named feelings correlate with the actual dominant drive(s)
  (property-testable: dominant drive above band threshold ⇒ mentioned; drive below
  threshold ⇒ not mentioned at low disclosure).
- Given low aggregate pressure and a non-guardian speaker, `shareable` is a brief,
  low-detail response; given one drive strongly elevated, `shareable` names that feeling;
  given high aggregate pressure and the guardian, `shareable` discloses more than the
  low-pressure case (three-point monotonicity check).
- The prompt paths at deliberation.service.ts and action-handler-registry.service.ts no
  longer contain raw `name: 0.NN` drive serializations (grep-able check + prompt-capture
  ring assertion).
- "How are you?" end-to-end: response is GROUNDED (via 009's path), reads naturally, and
  contains no numeric readout.

## Scope hints

- Owner: `cortex` (decision-making prompt paths) with the verbalizer itself likely in
  `packages/decision-making/src/deliberation/` or shared; conceptual reviewer `luria`
  (self-perception/interoception framing) and `skinner` (disclosure-as-behavior);
  `code-reviewer` as always.
- Read-only drive access via existing `IDriveStateReader.getCurrentState()` — no new
  read path into the drive engine (drive isolation stands).

## Non-goals

- No LLM in the verbalizer itself (deterministic, testable).
- No new drive-engine surface; no changes to drive computation.
- Not the stage-direction/emote problem (separate item filed same day).
- Not the engagement/deferral mechanism (separate future feature).

## DB impact

None (code only, read-only drive access).
