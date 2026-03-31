# 2026-03-29 — Implement Social Drive Contingency Tracker (E6-T011)

## Changes

- **NEW: `src/communication/social/social-contingency.service.ts`** — Complete implementation of the Social Contingency Service. Tracks Sylphie-initiated comments and detects guardian responses within the 30-second window. Reports contingency matches to Drive Engine for automatic reinforcement (Social -0.15, Satisfaction +0.10). Includes:
  - `trackSylphieInitiated(utteranceId, timestamp)` — Register a Sylphie-initiated comment
  - `checkGuardianResponse(timestamp, sessionId, driveSnapshot, matchedUtteranceId?)` — Detect response within window; emits event and reports outcome
  - In-memory Map tracking with periodic cleanup every 60s
  - OnModuleDestroy lifecycle hook for graceful shutdown

- **NEW: `src/communication/social/__tests__/social-contingency.service.spec.ts`** — Comprehensive test suite with 20 tests covering:
  - Basic utterance tracking
  - Contingency detection within 30-second window
  - Rejection of responses outside window and invalid scenarios
  - Event emission to TimescaleDB (SOCIAL_CONTINGENCY_MET)
  - Drive Engine outcome reporting with correct drive effects
  - Memory cleanup and lifecycle management
  - LIFO matching without specific utterance ID
  - Integration scenarios (rapid responses, timestamp boundaries)

- **MODIFIED: `src/shared/types/event.types.ts`**
  - Added `'SOCIAL_CONTINGENCY_MET'` to EventType union
  - Added SOCIAL_CONTINGENCY_MET entry to EVENT_BOUNDARY_MAP (COMMUNICATION subsystem)
  - Updated Communication event count from 7 to 8 in documentation

## Wiring Changes

- SocialContingencyService depends on:
  - IEventService (EVENTS_SERVICE token) — for emitting SOCIAL_CONTINGENCY_MET events
  - IActionOutcomeReporter (ACTION_OUTCOME_REPORTER token) — for reporting contingency outcomes to Drive Engine

- Event flow: SOCIAL_COMMENT_INITIATED → trackSylphieInitiated() → (guardian message received) → checkGuardianResponse() → SOCIAL_CONTINGENCY_MET event + Drive Engine outcome

## Implementation Details

### 30-Second Window Spec (CANON)
- Response window: 30 seconds with 35-second safety tolerance for clock skew
- Contingency met when latencyMs <= 30000ms
- Entries expire after 35s and are cleaned up automatically every 60s

### Drive Effects (CANON)
When contingency is detected, Drive Engine receives:
- Social: -0.15 (relief from social drive)
- Satisfaction: +0.10 (satisfaction with interaction quality)
- Feedback source: GUARDIAN
- Success: true

### Theater Prohibition (CANON Standard 1)
- Outcome report includes theaterCheck with expressionType='none' (no emotion expressed)
- This signals that the contingency is not a behavioral expression to be validated

### Memory Management
- Pending utterances stored in in-memory Map<utteranceId, PendingUtterance>
- Cleanup interval (60s) removes entries older than 35s
- OnModuleDestroy clears interval to prevent orphaned timers
- No memory leak risk: map size bounded by response window

## Known Issues

None. All 20 tests pass. Build succeeds with no errors or warnings.

## Gotchas for Next Session

1. **Drive name enums are camelCase**: When using DriveName enum, use `DriveName.Social` (enum accessor) which resolves to `'social'` (string value). Tests must match the camelCase string values.

2. **Event type narrowing**: The TypeScript type system's Extract utility for narrowing event types to subsystems can be finicky. If adding new events, ensure they're in the EventType union AND the EVENT_BOUNDARY_MAP. Building the project (npm run build) refreshes TypeScript's cache better than `tsc --noEmit` alone.

3. **DriveSnapshot structure**: Full snapshot includes pressureVector, driveDeltas, ruleMatchResult, tickNumber, sessionId, timestamp, and totalPressure. Mocks must include all fields.

4. **Utterance matching logic**: LIFO (Last-In-First-Out) matching ensures that if multiple utterances are pending and a guardian message arrives without a specific utterance ID, the most recent utterance is matched first. This is correct behavior for natural conversation flow.

5. **Event emission is fire-and-forget**: The SOCIAL_CONTINGENCY_MET event emission is async and uses `.catch()` to log errors without throwing. This prevents contingency detection from blocking on database writes.
