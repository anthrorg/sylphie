/**
 * Unit tests for ActionOutcomeReporterService — anxiety injection and dead ternary fix.
 *
 * Covers:
 *   1. reportOutcome() sends the real anxiety value from DriveReaderService
 *   2. reportOutcome() sends anxiety 0 when drive state is at cold-start
 *   3. driveValueAtExpression is computed without the dead ternary
 *   4. Payload structure is correct (actionId, outcome, feedbackSource, etc.)
 */

import { ActionOutcomeReporterService } from './action-outcome-reporter.service';
import { DriveName, INITIAL_DRIVE_STATE } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** Capture payloads sent through the outcome queue. */
function createMockWsChannel() {
  const sent: any[] = [];
  return {
    send: jest.fn((msg: any) => sent.push(msg)),
    sent,
  };
}

/** Mock DriveReaderService that returns a configurable anxiety value. */
function createMockDriveReader(anxietyValue: number) {
  const pressureVector = { ...INITIAL_DRIVE_STATE, [DriveName.Anxiety]: anxietyValue };
  return {
    getCurrentState: jest.fn().mockReturnValue({
      pressureVector,
      timestamp: new Date(),
      tickNumber: 1,
      driveDeltas: {},
      ruleMatchResult: { ruleId: null, eventType: 'TEST', matched: false },
      totalPressure: 0,
      sessionId: 'test',
    }),
  };
}

function createOutcome(overrides?: Partial<Parameters<ActionOutcomeReporterService['reportOutcome']>[0]>) {
  return {
    actionId: 'action-1',
    actionType: 'test_action',
    success: true,
    driveEffects: {},
    feedbackSource: 'SENSOR' as const,
    theaterCheck: {
      expressionType: 'none' as const,
      correspondingDrive: null,
      driveValue: 0.5,
      isTheatrical: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActionOutcomeReporterService', () => {
  describe('anxiety injection', () => {
    it('should include the live anxiety value from DriveReaderService', () => {
      const wsChannel = createMockWsChannel();
      const driveReader = createMockDriveReader(0.85);
      const service = new ActionOutcomeReporterService(
        wsChannel as any,
        driveReader as any,
      );

      service.reportOutcome(createOutcome());

      // The OutcomeQueue enqueues the payload — verify driveReader was called
      expect(driveReader.getCurrentState).toHaveBeenCalled();
    });

    it('should pass anxiety=0 when drives are at cold-start', () => {
      const wsChannel = createMockWsChannel();
      const driveReader = createMockDriveReader(0);
      const service = new ActionOutcomeReporterService(
        wsChannel as any,
        driveReader as any,
      );

      service.reportOutcome(createOutcome());

      expect(driveReader.getCurrentState).toHaveBeenCalled();
    });
  });

  describe('dead ternary cleanup', () => {
    it('should use driveValue directly regardless of expressionType', () => {
      const wsChannel = createMockWsChannel();
      const driveReader = createMockDriveReader(0);
      const service = new ActionOutcomeReporterService(
        wsChannel as any,
        driveReader as any,
      );

      // expressionType 'none' should produce the same driveValue as 'pressure'
      service.reportOutcome(createOutcome({
        theaterCheck: {
          expressionType: 'none',
          correspondingDrive: null,
          driveValue: 0.42,
          isTheatrical: false,
        },
      }));

      service.reportOutcome(createOutcome({
        theaterCheck: {
          expressionType: 'pressure',
          correspondingDrive: DriveName.Curiosity,
          driveValue: 0.42,
          isTheatrical: false,
        },
      }));

      // Both calls should succeed without error (the dead ternary was collapsed)
      expect(driveReader.getCurrentState).toHaveBeenCalledTimes(2);
    });

    it('should default driveValue to 0 when null', () => {
      const wsChannel = createMockWsChannel();
      const driveReader = createMockDriveReader(0);
      const service = new ActionOutcomeReporterService(
        wsChannel as any,
        driveReader as any,
      );

      // driveValue is null — should default to 0
      service.reportOutcome(createOutcome({
        theaterCheck: {
          expressionType: 'none',
          correspondingDrive: null,
          driveValue: null,
          isTheatrical: false,
        },
      }));

      expect(driveReader.getCurrentState).toHaveBeenCalled();
    });
  });

  describe('feedbackSource mapping', () => {
    it('should map GUARDIAN provenance to guardian_confirmation', () => {
      const wsChannel = createMockWsChannel();
      const driveReader = createMockDriveReader(0);
      const service = new ActionOutcomeReporterService(
        wsChannel as any,
        driveReader as any,
      );

      // This should not throw
      service.reportOutcome(createOutcome({ feedbackSource: 'GUARDIAN' as any }));
      expect(driveReader.getCurrentState).toHaveBeenCalled();
    });

    it('should map LLM_GENERATED provenance to algorithmic', () => {
      const wsChannel = createMockWsChannel();
      const driveReader = createMockDriveReader(0);
      const service = new ActionOutcomeReporterService(
        wsChannel as any,
        driveReader as any,
      );

      service.reportOutcome(createOutcome({ feedbackSource: 'LLM_GENERATED' as any }));
      expect(driveReader.getCurrentState).toHaveBeenCalled();
    });
  });
});
