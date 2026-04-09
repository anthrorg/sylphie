# Idea: Implement Real Theater Prohibition Validation

**Created:** 2026-04-09
**Status:** proposed

## Summary

The `checkTheaterProhibition` method in `CommunicationService` (`apps/sylphie/src/services/communication.service.ts`, line 778) has a TODO for real theater validation. Currently it only flags when anxiety > 0.7 and a response exists, but does not actually compare response sentiment against the drive state vector as CANON requires.

## Motivation

CANON's Theater Prohibition prevents the system from expressing emotions it doesn't actually feel — e.g., sounding cheerful when anxiety is high, or expressing sadness when the drive state is neutral. The current implementation is a rough heuristic that only catches one edge case (high anxiety + any response). A proper implementation would analyze response sentiment/tone and compare it against the full drive state vector to detect mismatches across all drives, not just anxiety.

## Subsystems Affected

- **apps/sylphie** — `CommunicationService.checkTheaterProhibition()` needs sentiment analysis of the response text and comparison logic against drive state.
- **decision-making** — May need to expose a sentiment analysis utility or leverage the LLM for quick tone classification.

## Open Questions

- Should sentiment analysis be done via a lightweight classifier (e.g., VADER/TextBlob) or via the LLM?
- What drive-to-sentiment mappings are needed? (e.g., high Curiosity → inquisitive tone, high Anxiety → cautious tone)
- What should happen when a theater violation is detected? Should the response be regenerated, suppressed, or just flagged?
