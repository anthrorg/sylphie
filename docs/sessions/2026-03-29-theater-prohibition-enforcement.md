# 2026-03-29 -- Theater Prohibition enforcement (E4-T011)

## Changes

- NEW: `src/drive-engine/constants/action-emotions.ts` -- Action-to-emotion mapping system for Theater Prohibition checks. Extensible map of action types to emotional expressions with drive directionality thresholds.
- NEW: `src/drive-engine/drive-process/theater-prohibition.ts` -- Core Theater Prohibition detection module. Performs post-flight verification that emotional expressions (pressure/relief) correlate with actual drive state.
- NEW: `src/drive-engine/drive-process/drive-correlation-check.ts` -- Directional drive correlation validation (pressure > 0.2, relief < 0.3). Separated for testability.
- NEW: `src/drive-engine/drive-process/reinforcement-blocking.ts` -- Zero-reinforcement filter for theatrical expressions. Blocks all drive effects when expression fails directional check.
- MODIFIED: `src/drive-engine/drive-process/drive-engine.ts` -- Integrated Theater Prohibition into `applyOutcome()`. CANON Standard 1 enforcement now blocks reinforcement for theatrical outputs with stderr logging.

## Wiring Changes

- `applyOutcome()` now calls `detectTheater()` for every ACTION_OUTCOME before applying effects
- Theater detection uses current drive state from DriveStateManager for post-flight verification
- If theatrical, `filterEffectsForTheater()` zeros out all drive effects
- Prohibition events logged to stderr with action type, expression type, drive name, and drive value for debugging

## Known Issues

None. TypeScript type-checking passes without errors.

## Gotchas for Next Session

- ACTION_EMOTION_MAPPINGS is mutable at runtime (via `registerActionEmotionMapping()`). Ensure Learning subsystem uses this for new action types.
- Theater prohibition is **zero-tolerance**: any theatrical expression receives zero reinforcement regardless of guardian feedback or outcome quality.
- Drive directionality thresholds (0.2 for pressure, 0.3 for relief) are hardcoded in both `theater-prohibition.ts` and `drive-correlation-check.ts` for consistency; any change must update both.
- The `emitTheaterProhibitedEvent()` stub can be extended to emit via event emitter or TimescaleDB if event tracking is needed.
