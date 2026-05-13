# Idea: Trigger Learning Cycles on Cognitive Awareness Drive Pressure

**Created:** 2026-04-27
**Status:** proposed

## Summary

`LearningService` (`packages/learning/src/learning.service.ts`, JSDoc lines 8-11) is documented as using `setInterval` (`CYCLE_INTERVAL_MS`) as a "fallback trigger." The header explicitly states: "In a future phase, the Cognitive Awareness drive should trigger cycles when pressure exceeds a threshold. For now, the timer fires every CYCLE_INTERVAL_MS." The pressure-based trigger has not been wired.

## Motivation

CANON §Drive Engine and §Subsystem 3 (Learning) describe Sylphie's behavior as drive-mediated -- maintenance work should arise from drive pressure, not from a clock. A timer-only trigger means consolidation runs on a fixed cadence regardless of how much unlearned material has accumulated, which is wasteful when nothing is pending and tardy when many events queue up. Wiring Cognitive Awareness pressure as the primary trigger (with the timer demoted to a safety-net floor) would make consolidation contingent on actual cognitive load and unify the Learning subsystem with the rest of Sylphie's drive-mediated behavior model.

## Subsystems Affected

- **learning** -- `LearningService` needs to subscribe to drive-state events (e.g., `DRIVE_TICK` or a Cognitive Awareness threshold-cross signal) and invoke `runMaintenanceCycle()` when pressure exceeds a configured threshold.
- **drive-engine** -- May need to expose Cognitive Awareness pressure crossings via IPC or via the existing TimescaleDB event backbone.

## Open Questions

- Should the timer be removed entirely once pressure-triggered cycles work, or retained as a safety floor (e.g., one cycle per N minutes minimum)?
- What pressure threshold should trigger a cycle? Is it static or learned?
- Should backpressure be respected -- if a cycle is already in flight, does the trigger queue or drop?
