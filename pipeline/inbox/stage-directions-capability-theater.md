# Bug: Roleplay stage directions in responses ("*tilts head*", "*winces*") — capability theater passing unfiltered

From Jim, 2026-07-02: "There is a lot of 'tilts head', 'winces closely' type conversation.
Humans don't do that. Those are visual cues and it's mostly for storytelling. Not natural
conversation."

## Root cause (verified in source)

1. **No prohibition anywhere.** The candidate-generation persona prompt
   (`packages/decision-making/src/deliberation/deliberation.service.ts:531-533`) says
   "Be warm, natural, and conversational. You are NOT a chatbot or assistant." — an LLM
   trained on chat/RP data reads "natural and conversational" as permitting emote markers.
   No prompt in the response path forbids gestures/actions/stage directions.
2. **No output filtering.** Post-processing (deliberation.service.ts:789-807) strips only
   grounding tags; `*tilts head*` passes through untouched. Same gap in the LLM_GENERATE
   action handler (`action-handler-registry.service.ts:250-256`).

## Framing: this is capability theater

Narrating a physical action she cannot perform ("*tilts head*" — she has no head to tilt)
is a fabricated-capability claim, squarely in scope of the existing theater machinery:
`theater-capability-detector.ts` / `theater-capability-corpus.ts` and the extinction path
`CycleOutcomeReporterService.extinctAction`
(`apps/sylphie/src/services/cycle-outcome-reporter.service.ts:306`). TK-101 established
the pattern: theater is ENFORCED and LEARNED, not just instructed away.

## Fix (two layers, mirroring TK-101)

1. **Prompt-side (cheap, immediate):** add an explicit rule to the response-generation
   system prompts: no stage directions, no asterisk/emote actions, no narrated physical
   gestures — speak as a voice, not a storybook character. Sites: deliberation.service.ts
   candidate-generation (and monologue/arbiter as appropriate) +
   action-handler-registry.service.ts LLM_GENERATE.
2. **Enforcement-side (durable):** extend the theater-capability corpus/detector to flag
   narrated physical actions (asterisk-wrapped or third-person action clauses) as
   capability violations, so detected instances get the existing negative extinction
   signal and the behavior is unlearned, not merely masked. Optionally strip the marker
   from the delivered text on detection (don't ship the emote even while learning).

## Acceptance criteria (sketch)

- Given a response candidate containing an asterisk-wrapped action or narrated gesture,
  the theater check flags it as a capability violation and `extinctAction` fires (unit
  test on the detector with a small corpus of emote patterns; include negatives —
  legitimate uses of `*` such as emphasis or math shouldn't false-positive).
- Delivered `cb_speech` text contains no `*...*` action markers over a scripted smoke
  conversation that historically elicited them (greeting + "how are you" + emotional
  topic).
- Prompt-capture ring shows the anti-stage-direction rule present in the composed
  system prompts on both paths.

## Scope hints

- Owners: `vox` (Theater Prohibition enforcement, communication delivery) for the
  detector/corpus + `cortex` for the decision-making prompt strings; conceptual reviewer
  `skinner` (extinction schedule), `code-reviewer`.

## Non-goals

- Not the drive-readout/disclosure problem (separate item: feeling verbalizer).
- No change to the theater affect-scorer's existing tonal-affect checks.
- No LLM-based emote classifier — pattern/corpus detection is enough at this rigor.

## DB impact

None (prompt strings + detector corpus + tests).
