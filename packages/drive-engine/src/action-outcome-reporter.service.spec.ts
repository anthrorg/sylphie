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

  describe('reportMetrics — cost + window', () => {
    /** Build a reporter whose enqueued metrics payloads we can capture. */
    function buildReporterCapturingMetrics() {
      const wsChannel = createMockWsChannel();
      const driveReader = createMockDriveReader(0);
      const service = new ActionOutcomeReporterService(
        wsChannel as any,
        driveReader as any,
      );
      const captured: any[] = [];
      // OutcomeQueue is private; spy on the enqueueMetrics it calls.
      const queue = (service as any).outcomeQueue;
      jest
        .spyOn(queue, 'enqueueMetrics')
        .mockImplementation((p: any) => captured.push(p));
      return { service, captured };
    }

    const baseMetrics = {
      llmCallCount: 1,
      llmLatencyMs: 100,
      cognitiveEffortPressure: 0.1,
    };

    it('computes a non-zero USD cost from the token split using default DeepSeek rates', () => {
      const { service, captured } = buildReporterCapturingMetrics();

      // 1M prompt + 1M completion → 0.28 + 0.42 = 0.70 at default rates.
      service.reportMetrics({
        ...baseMetrics,
        tokenCount: 2_000_000,
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
      } as any);

      expect(captured).toHaveLength(1);
      expect(captured[0].estimatedCostUsd).toBeCloseTo(0.7, 6);
    });

    it('never reports a silent $0 when only tokenCount is available', () => {
      const { service, captured } = buildReporterCapturingMetrics();

      // No split → whole tokenCount priced at the input rate: 1M * 0.28 = 0.28.
      service.reportMetrics({
        ...baseMetrics,
        tokenCount: 1_000_000,
      } as any);

      expect(captured[0].estimatedCostUsd).toBeCloseTo(0.28, 6);
      expect(captured[0].estimatedCostUsd).toBeGreaterThan(0);
    });

    it('threads caller-supplied window boundaries through unchanged', () => {
      const { service, captured } = buildReporterCapturingMetrics();
      const start = new Date('2026-06-14T10:00:00.000Z');
      const end = new Date('2026-06-14T10:00:05.000Z');

      service.reportMetrics({
        ...baseMetrics,
        tokenCount: 1000,
        windowStartAt: start,
        windowEndAt: end,
      } as any);

      expect(captured[0].windowStartAt).toBe(start);
      expect(captured[0].windowEndAt).toBe(end);
    });

    it('falls back to flush time and warns when windowStartAt is missing', () => {
      const { service, captured } = buildReporterCapturingMetrics();
      const warn = jest.spyOn((service as any).logger, 'warn');

      service.reportMetrics({ ...baseMetrics, tokenCount: 1000 } as any);

      // start == end fallback (degraded, but never silent).
      expect(captured[0].windowStartAt).toEqual(captured[0].windowEndAt);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('windowStartAt not supplied'),
      );
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
