/**
 * Unit tests for DecisionEventLoggerService — batch INSERT flush.
 *
 * Covers:
 *   1. Successful batch insert (single multi-row INSERT)
 *   2. Empty buffer produces no query
 *   3. Batch failure logs error with event count and types
 *   4. buildBatchInsert produces correct parameterized SQL
 */

import { DecisionEventLoggerService } from './decision-event-logger.service';
import type { DriveSnapshot } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_DRIVE_SNAPSHOT: DriveSnapshot = {
  curiosity: 0.5,
  satisfaction: 0.4,
  social: 0.3,
  mastery: 0.2,
  autonomy: 0.1,
  security: 0.6,
  energy: 0.7,
  comfort: 0.8,
  novelty: 0.35,
  attachment: 0.45,
  play: 0.55,
  competence: 0.65,
} as DriveSnapshot;

/** Minimal mock for TimescaleService — only needs a query() method. */
function createMockTimescale() {
  return {
    query: jest.fn().mockResolvedValue(undefined),
  };
}

/** Build a DecisionEventLoggerService with the given mock timescale. */
function createService(mockTimescale: ReturnType<typeof createMockTimescale>) {
  return new DecisionEventLoggerService(mockTimescale as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DecisionEventLoggerService', () => {
  let mockTimescale: ReturnType<typeof createMockTimescale>;
  let service: DecisionEventLoggerService;

  beforeEach(() => {
    jest.useFakeTimers();
    mockTimescale = createMockTimescale();
    service = createService(mockTimescale);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('flush()', () => {
    it('should issue a single multi-row INSERT for multiple buffered events', async () => {
      // Buffer 3 events
      service.log('INPUT_CATEGORIZED', { category: 'greeting' }, STUB_DRIVE_SNAPSHOT, 'session-1');
      service.log('CANDIDATE_RETRIEVED', { count: 5 }, STUB_DRIVE_SNAPSHOT, 'session-1');
      service.log('ACTION_SELECTED', { actionId: 'a1' }, STUB_DRIVE_SNAPSHOT, 'session-1', 'corr-1');

      // Flush manually
      await service.flush();

      // Should have been called exactly once (batch INSERT, not 3 times)
      expect(mockTimescale.query).toHaveBeenCalledTimes(1);

      const [sql, params] = mockTimescale.query.mock.calls[0];

      // SQL should contain 3 value groups
      expect(sql).toContain('INSERT INTO events');
      expect(sql).toContain('VALUES');
      // 3 events × 9 columns = 27 parameters
      expect(params).toHaveLength(27);

      // Verify subsystem is always DECISION_MAKING (every 4th param in each group of 9)
      expect(params[3]).toBe('DECISION_MAKING');
      expect(params[12]).toBe('DECISION_MAKING');
      expect(params[21]).toBe('DECISION_MAKING');

      // Verify event types are preserved
      expect(params[1]).toBe('INPUT_CATEGORIZED');
      expect(params[10]).toBe('CANDIDATE_RETRIEVED');
      expect(params[19]).toBe('ACTION_SELECTED');

      // Verify correlation_id is passed through (3rd event has 'corr-1', others null)
      expect(params[7]).toBeNull();   // event 1 correlation_id
      expect(params[16]).toBeNull();  // event 2 correlation_id
      expect(params[25]).toBe('corr-1'); // event 3 correlation_id
    });

    it('should be a no-op when the buffer is empty', async () => {
      await service.flush();
      expect(mockTimescale.query).not.toHaveBeenCalled();
    });

    it('should log an error with event count and types on batch failure', async () => {
      const loggerSpy = jest.spyOn((service as any).logger, 'error');
      mockTimescale.query.mockRejectedValueOnce(new Error('connection refused'));

      service.log('INPUT_CATEGORIZED', {}, STUB_DRIVE_SNAPSHOT, 'session-1');
      service.log('PREDICTION_MADE', {}, STUB_DRIVE_SNAPSHOT, 'session-1');

      await service.flush();

      expect(loggerSpy).toHaveBeenCalledTimes(1);
      const errorMsg = loggerSpy.mock.calls[0][0] as string;
      expect(errorMsg).toContain('2 decision events');
      expect(errorMsg).toContain('INPUT_CATEGORIZED');
      expect(errorMsg).toContain('PREDICTION_MADE');
      expect(errorMsg).toContain('connection refused');
    });

    it('should produce correct placeholder numbering in SQL', async () => {
      service.log('INPUT_CATEGORIZED', {}, STUB_DRIVE_SNAPSHOT, 'session-1');
      service.log('ACTION_SELECTED', {}, STUB_DRIVE_SNAPSHOT, 'session-1');

      await service.flush();

      const [sql] = mockTimescale.query.mock.calls[0];
      // First row: $1-$9, second row: $10-$18
      expect(sql).toContain('$1,');
      expect(sql).toContain('$9)');
      expect(sql).toContain('$10,');
      expect(sql).toContain('$18)');
    });
  });
});
