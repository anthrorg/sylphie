# Cortex Analysis — Epic 6: Communication Interface

**Agent:** Cortex (Decision Making Engineer)
**Model:** sonnet
**Date:** 2026-03-29

## Summary

Communication is Decision Making's primary interface to the outside world. The contract is clean: Cortex selects WHAT (ActionIntent), Communication implements HOW (natural language). The boundary must never blur.

## Interface Contract

### Input Flow: Guardian → Decision Making
```
Guardian speaks/types
  → Communication: STT (if voice) + InputParser
  → ParsedInput {
      raw: string,
      source: 'TEXT' | 'VOICE',
      intent: InputIntent,
      entities: ExtractedEntity[],
      guardianFeedbackType: GuardianFeedbackType,
      conversationId: string,
      referencedEntities: WKGNodeRef[],
      confidence: number,
      parseMethod: 'LLM_ASSISTED' | 'PATTERN_MATCH'
    }
  → Decision Making: processInput(parsedInput)
```

### Output Flow: Decision Making → Guardian
```
Decision Making selects action
  → ActionIntent {
      type: 'RESPOND' | 'INITIATE' | 'ACKNOWLEDGE' | 'CLARIFY',
      topic: string,
      contentHint: string,
      emotionalIntentFromDrives: DriveSnapshot,
      conversationId: string,
      decisionReasoning?: string
    }
  → Communication: generateResponse(intent)
  → LLM Context Assembly → LLM Call → Theater Validation → TTS/Chatbox
  → CommunicationResponse back to Decision Making (for prediction evaluation)
```

## Critical Requirements from Cortex

1. **ParsedInput must include guardianFeedbackType** — Cortex needs to know if this is a correction (3x weight) to route through the confidence update pipeline correctly.

2. **CommunicationResponse must include theaterCheck** — Cortex needs to know if the response was flagged as Theater, because this affects the prediction evaluation (Theater = no learning signal).

3. **Latency must be tracked** — Total response time is reported as Type 2 cost. If Communication is slow, Cortex sees cognitive effort pressure accumulate.

4. **Communication must NOT select actions** — If the LLM starts deciding what to talk about (rather than how to say what Cortex selected), the decision loop becomes invisible to learning.

## Prediction Closure

Every communication action has an implicit prediction:
- "If I say X, the guardian will respond with Y, and my drives will change by Z"
- After guardian responds, Cortex evaluates: did the prediction match?
- Accurate: confidence increases, approach Type 1 graduation
- Inaccurate: confidence decreases, create Opportunity for Planning

Communication's role: deliver the response faithfully and report what actually happened (guardian's response, timing, engagement level).

## Shared Tickets (E5 ↔ E6)

- Drive read interface design (E5 exposes, E6 consumes)
- ActionIntent type definition (E5 produces, E6 consumes)
- Prediction evaluation for communication actions (E5 evaluates, E6 reports outcome)
- Guardian feedback event schema (E6 detects, E5 processes)

## Risks from DM Perspective

1. **Latency cascade** — If total latency > 2s, guardian disengages, learning stops
2. **Theater emergence** — LLM generates "helpful assistant" instead of drive-authentic
3. **Person model poisoning** — Bad inferences about Jim lead to bad predictions
4. **Intent misclassification** — Wrong guardianFeedbackType = wrong confidence weight
5. **Reference resolution failure** — "it" resolves wrong = prediction fails
