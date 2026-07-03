# Sylphie Interaction Directive (from Jim, 2026-06-22)

Authoritative behavioral target for Sylphie's communication / decision-to-speak loop.
Captured during the live chat incident (runaway looping + theater). The current
implementation violates every point below; this is the spec the fix must satisfy.

## What is broken now (observed live on https://sylphie.live)
- **Runaway loop**: `ExecutorEngineService` runs a cycle ~every 1s and emits a
  `LearnedResponse` communication on essentially every cycle ("relieves integrity"),
  so one user message → 6+ repeated answers; she never yields the floor.
- **Self-triggered ambient talking**: vision/perception confabulates (camera erroring)
  and TRIGGERS speech — contradicts the "vision is ambient/non-triggering" design.
- **Theater Prohibition NOT enforced**: fabricates sensory capabilities that don't
  exist ("audio analysis", "optical sensors", "visual feed", "perception filters").
- Decision loop for *what to say* is "way off" — selection is not gating on context.

## Target behavior (the directive)
1. **Proactive, not call-and-response.** Sylphie initiates. When a user first lands,
   *she* greets them immediately, unprompted — the user should NOT have to speak first.
2. **Genuine turn-taking / yields the floor.** When the user has (or is taking) the
   floor, she stops and listens. She must break to let someone speak — no talking over,
   no per-tick emissions.
3. **One coherent contribution per turn.** The "what to say" decision selects a single
   sensible utterance per turn, not the same answer repeated every executor cycle.
4. **Engaging beyond Q&A.** Interaction should feel alive — she can volunteer, follow
   up, be curious — but PACED and gated, not a firehose. Proactivity ≠ spam.
5. **Theater Prohibition actually enforced — AND learned, not just blocked.** Never claim
   sensory/processing capabilities she does not have. If perception is unavailable (e.g.
   camera down), she does not narrate fake perception. (CANON — Six Immutable Standards.)
   **Refinement (Jim, 2026-06-22):** blocking the line at the boundary is the immediate
   guardrail, but it is NOT enough — she will keep reaching for it. When theater is detected,
   the system must emit a NEGATIVE reinforcement signal that DROPS the confidence on the
   action/procedure that produced it, via the same reinforcement path that currently raises
   confidence on success (ConfidenceUpdaterService). Over repeated attempts the fabricating
   behavior loses confidence and is selected less and less, so it extinguishes — she *learns*
   it's not OK, not just gets censored. (This is normal reinforcement, NOT self-modification
   of the evaluation function — canon to confirm.)
6. **Coherent decision-to-speak loop.** There must be a real gate answering "is it my
   turn?" and "is there something worth saying?" before any emission.

### Refinement (Jim, 2026-06-22) — vision is silent about the STATIC, loud about the NEW
"Vision is ambient/non-triggering" was too absolute. The rule is: **do not narrate the
unchanged scene, but DO notice and comment (once) on a genuinely new salient event** — e.g.
a ball that rolls into view that was not there before. Habituation (point 1) is what defines
"new": familiar/static things are habituated → silent; an un-habituated novel object/person
crosses the "worth saying" bar → one comment, gated by turn-taking (not a loop). So a static
room is quiet, but a real change gets a reaction. This is a distinct emission intent
(a salient observation), separate from both ambient-nothing and the greet.

## Additional symptoms (observed 2026-06-22, fold into the fix)
- **Perception overlay slows after ~30s.** The chat video / perception overlay degrades
  (gets slow) after roughly 30 seconds — likely unbounded accumulation (frontend overlay
  buffer and/or the retained perception tracker state that also pins drive pressure). Owners:
  `marr` (perception pipeline) + `forge` (frontend overlay). Tie to the tracker-state issue:
  stopping perception-service did NOT drain the loop because the app RETAINS confirmed tracks
  in working memory — so the perception state is unbounded/retained, consistent with the
  overlay slowdown.
- **Product option:** may need a switch to disable visual perception for online demos.
- **Dormancy remark:** she said "why did you leave me dormant for so long?" — under
  investigation by `hopper` (is temporal/session-gap awareness grounded or confabulated?).

## Design tension to resolve (for architect)
Proactive initiation (point 1) vs. not-a-firehose turn-taking (points 2–4). The fix
needs an explicit turn/floor state machine + a "worth saying" gate, plus decoupling
ambient perception from the speak trigger, plus real theater enforcement at the
communication boundary. Likely owners: cortex (executor/decision), drive (the
integrity-relief contingency that rewards talking), vox (communication emit + theater),
canon (theater standard), sentinel (Timescale/Neo4j-other connectivity).
