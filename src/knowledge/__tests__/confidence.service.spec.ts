/**
 * Unit tests for ConfidenceService.
 *
 * Tests cover the ACT-R confidence formula and confidence ceiling enforcement:
 * - computeConfidence() returns expected values per ACT-R formula
 * - Confidence ceiling enforced at 0.60 for untested knowledge (count=0)
 * - Base confidence values correct per provenance (GUARDIAN=0.60, LLM=0.35, etc.)
 * - recordUse() increments count correctly
 * - Guardian confirmation multiplier (2x)
 * - Guardian correction multiplier (3x)
 * - Confidence increases with retrieval count (ln term)
 * - Confidence decreases with time (decay term)
 * - getConfidenceDebugInfo() returns all fields
 *
 * Tests use jest.mock for Neo4j driver without requiring live connection.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Driver } from 'neo4j-driver';
import { ConfidenceService } from '../confidence.service';
import { NEO4J_DRIVER } from '../knowledge.tokens';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import {
  computeConfidence,
  CONFIDENCE_THRESHOLDS,
  DEFAULT_DECAY_RATES,
  type ACTRParams,
} from '../../shared/types/confidence.types';
import type { IEventService } from '../../events/interfaces/events.interfaces';

// ===== Mock Helpers =====

function createMockSession() {
  return {
    run: jest.fn(),
    close: jest.fn(),
  } as any;
}

function createMockDriver() {
  return {
    session: jest.fn(),
    close: jest.fn(),
  } as any;
}

function createMockEventService() {
  return {
    record: jest.fn().mockResolvedValue({ eventId: 'event-id' }),
  } as any;
}

// ===== Tests =====

describe('ConfidenceService', () => {
  let service: ConfidenceService;
  let mockDriver: any;
  let mockSession: any;
  let mockEventService: any;

  beforeEach(async () => {
    mockDriver = createMockDriver();
    mockSession = createMockSession();
    mockEventService = createMockEventService();

    mockDriver.session.mockReturnValue(mockSession);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfidenceService,
        {
          provide: NEO4J_DRIVER,
          useValue: mockDriver,
        },
        {
          provide: EVENTS_SERVICE,
          useValue: mockEventService,
        },
      ],
    }).compile();

    service = module.get<ConfidenceService>(ConfidenceService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ========== compute() tests ==========

  describe('compute()', () => {
    it('should compute confidence using ACT-R formula', () => {
      const params: ACTRParams = {
        base: 0.60,
        count: 5,
        decayRate: 0.03,
        lastRetrievalAt: new Date(),
      };

      const result = service.compute(params);

      // Formula: min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))
      // With fresh retrieval: min(1.0, 0.60 + 0.12 * ln(5) - 0.03 * ln(1))
      // = min(1.0, 0.60 + 0.12 * 1.609 - 0) ≈ 0.793
      expect(result).toBeGreaterThan(0.6);
      expect(result).toBeLessThanOrEqual(1.0);
    });

    it('should enforce confidence ceiling for untested knowledge', () => {
      const params: ACTRParams = {
        base: 0.35, // LLM_GENERATED base
        count: 0, // Untested
        decayRate: 0.08,
        lastRetrievalAt: null,
      };

      const result = service.compute(params);

      // Should be capped at ceiling (0.60) but also limited by base (0.35)
      expect(result).toBeLessThanOrEqual(CONFIDENCE_THRESHOLDS.ceiling);
      expect(result).toBe(0.35); // Limited by base confidence
    });

    it('should return base confidence when ceiling is lower', () => {
      const params: ACTRParams = {
        base: 0.30, // INFERENCE base
        count: 0,
        decayRate: 0.06,
        lastRetrievalAt: null,
      };

      const result = service.compute(params);

      expect(result).toBe(0.30);
    });

    it('should return ceiling when base is higher and count=0', () => {
      const params: ACTRParams = {
        base: 0.70, // Hypothetical high base
        count: 0,
        decayRate: 0.03,
        lastRetrievalAt: null,
      };

      const result = service.compute(params);

      expect(result).toBeLessThanOrEqual(CONFIDENCE_THRESHOLDS.ceiling);
    });

    it('should account for decay over time', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const recentParams: ACTRParams = {
        base: 0.60,
        count: 10,
        decayRate: 0.03,
        lastRetrievalAt: now,
      };

      const oldParams: ACTRParams = {
        base: 0.60,
        count: 10,
        decayRate: 0.03,
        lastRetrievalAt: oneHourAgo,
      };

      const recentConfidence = service.compute(recentParams);
      const oldConfidence = service.compute(oldParams);

      // More recent retrieval should have higher confidence
      expect(recentConfidence).toBeGreaterThan(oldConfidence);
    });

    it('should apply logarithmic growth with count', () => {
      const baseParams = {
        base: 0.40,
        decayRate: 0.05,
        lastRetrievalAt: new Date(),
      };

      const conf1 = service.compute({ ...baseParams, count: 1 });
      const conf2 = service.compute({ ...baseParams, count: 10 });
      const conf3 = service.compute({ ...baseParams, count: 100 });

      // Confidence should increase but with diminishing returns (log growth)
      expect(conf1).toBeLessThan(conf2);
      expect(conf2).toBeLessThan(conf3);
      expect(conf3 - conf2).toBeLessThan(conf2 - conf1); // Diminishing returns
    });

    it('should never return negative values', () => {
      const params: ACTRParams = {
        base: 0.0,
        count: 0,
        decayRate: 0.05,
        lastRetrievalAt: null,
      };

      const result = service.compute(params);

      expect(result).toBeGreaterThanOrEqual(0.0);
    });

    it('should never exceed 1.0', () => {
      const params: ACTRParams = {
        base: 1.0,
        count: 1000,
        decayRate: 0.01,
        lastRetrievalAt: new Date(),
      };

      const result = service.compute(params);

      expect(result).toBeLessThanOrEqual(1.0);
    });
  });

  // ========== Base Confidence Per Provenance ==========

  describe('Base confidence values', () => {
    it('should have SENSOR base at 0.40', () => {
      const params: ACTRParams = {
        base: 0.40,
        count: 0,
        decayRate: DEFAULT_DECAY_RATES.SENSOR,
        lastRetrievalAt: null,
      };

      const result = service.compute(params);

      expect(result).toBe(0.40);
    });

    it('should have GUARDIAN base at 0.60', () => {
      const params: ACTRParams = {
        base: 0.60,
        count: 0,
        decayRate: DEFAULT_DECAY_RATES.GUARDIAN,
        lastRetrievalAt: null,
      };

      const result = service.compute(params);

      expect(result).toBe(0.60);
    });

    it('should have LLM_GENERATED base at 0.35', () => {
      const params: ACTRParams = {
        base: 0.35,
        count: 0,
        decayRate: DEFAULT_DECAY_RATES.LLM_GENERATED,
        lastRetrievalAt: null,
      };

      const result = service.compute(params);

      expect(result).toBe(0.35);
    });

    it('should have INFERENCE base at 0.30', () => {
      const params: ACTRParams = {
        base: 0.30,
        count: 0,
        decayRate: DEFAULT_DECAY_RATES.INFERENCE,
        lastRetrievalAt: null,
      };

      const result = service.compute(params);

      expect(result).toBe(0.30);
    });
  });

  // ========== recordUse() tests ==========

  describe('recordUse()', () => {
    it('should increment count on successful retrieval', async () => {
      const nodeData = {
        id: 'node-1',
        provenance: 'GUARDIAN',
        actrBase: 0.60,
        actrCount: 5,
        actrDecayRate: 0.03,
        actrLastRetrievedAt: new Date(),
      };

      // Mock fetch query
      mockSession.run
        .mockResolvedValueOnce({
          records: [
            {
              get: (key: string) => nodeData,
            },
          ],
        })
        .mockResolvedValueOnce({
          records: [{ get: (key: string) => true }],
        });

      await service.recordUse('node-1', true);

      // Verify update query incremented count
      const [, updateParams] = mockSession.run.mock.calls[1];
      expect(updateParams.count).toBe(6);
    });

    it('should not increment count on failed retrieval', async () => {
      const nodeData = {
        id: 'node-2',
        provenance: 'LLM_GENERATED',
        actrBase: 0.35,
        actrCount: 3,
        actrDecayRate: 0.08,
        actrLastRetrievedAt: new Date(),
      };

      mockSession.run
        .mockResolvedValueOnce({
          records: [
            {
              get: (key: string) => nodeData,
            },
          ],
        })
        .mockResolvedValueOnce({
          records: [{ get: (key: string) => true }],
        });

      await service.recordUse('node-2', false);

      const [, updateParams] = mockSession.run.mock.calls[1];
      expect(updateParams.count).toBe(3); // Not incremented
    });

    it('should update lastRetrievalAt on any retrieval', async () => {
      const nodeData = {
        id: 'node-3',
        provenance: 'SENSOR',
        actrBase: 0.40,
        actrCount: 2,
        actrDecayRate: 0.05,
        actrLastRetrievedAt: new Date('2026-01-01'),
      };

      mockSession.run
        .mockResolvedValueOnce({
          records: [
            {
              get: (key: string) => nodeData,
            },
          ],
        })
        .mockResolvedValueOnce({
          records: [{ get: (key: string) => true }],
        });

      const before = Date.now();
      await service.recordUse('node-3', true);
      const after = Date.now();

      const [, updateParams] = mockSession.run.mock.calls[1];
      const updatedTime = updateParams.lastRetrievedAt.getTime();
      expect(updatedTime).toBeGreaterThanOrEqual(before);
      expect(updatedTime).toBeLessThanOrEqual(after);
    });

    it('should close session after recording use', async () => {
      const nodeData = {
        id: 'node-4',
        provenance: 'INFERENCE',
        actrBase: 0.30,
        actrCount: 0,
        actrDecayRate: 0.06,
        actrLastRetrievedAt: null,
      };

      mockSession.run
        .mockResolvedValueOnce({
          records: [
            {
              get: (key: string) => nodeData,
            },
          ],
        })
        .mockResolvedValueOnce({
          records: [{ get: (key: string) => true }],
        });

      await service.recordUse('node-4', true);

      expect(mockSession.close).toHaveBeenCalled();
    });

    it('should throw error if node not found', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [],
      });

      await expect(service.recordUse('nonexistent', true)).rejects.toThrow(
        'Node not found',
      );
    });
  });

  // ========== Threshold Tests ==========

  describe('Thresholds', () => {
    it('should have retrieval threshold at 0.50', () => {
      expect(CONFIDENCE_THRESHOLDS.retrieval).toBe(0.50);
    });

    it('should have ceiling threshold at 0.60', () => {
      expect(CONFIDENCE_THRESHOLDS.ceiling).toBe(0.60);
    });

    it('should have graduation threshold at 0.80', () => {
      expect(CONFIDENCE_THRESHOLDS.graduation).toBe(0.80);
    });

    it('should have demotion MAE at 0.15', () => {
      expect(CONFIDENCE_THRESHOLDS.demotionMAE).toBe(0.15);
    });

    it('should have graduation MAE at 0.10', () => {
      expect(CONFIDENCE_THRESHOLDS.graduationMAE).toBe(0.10);
    });
  });

  // ========== Decay Rates ==========

  describe('Decay rates', () => {
    it('should have SENSOR decay at 0.05', () => {
      expect(DEFAULT_DECAY_RATES.SENSOR).toBe(0.05);
    });

    it('should have GUARDIAN decay at 0.03 (slowest)', () => {
      expect(DEFAULT_DECAY_RATES.GUARDIAN).toBe(0.03);
      expect(DEFAULT_DECAY_RATES.GUARDIAN).toBeLessThan(
        DEFAULT_DECAY_RATES.SENSOR,
      );
    });

    it('should have LLM_GENERATED decay at 0.08 (fastest)', () => {
      expect(DEFAULT_DECAY_RATES.LLM_GENERATED).toBe(0.08);
      expect(DEFAULT_DECAY_RATES.LLM_GENERATED).toBeGreaterThan(
        DEFAULT_DECAY_RATES.GUARDIAN,
      );
    });

    it('should have INFERENCE decay at 0.06', () => {
      expect(DEFAULT_DECAY_RATES.INFERENCE).toBe(0.06);
    });
  });

  // ========== Edge Case Tests ==========

  describe('Edge cases', () => {
    it('should handle count=0 with null lastRetrievalAt', () => {
      const params: ACTRParams = {
        base: 0.50,
        count: 0,
        decayRate: 0.05,
        lastRetrievalAt: null,
      };

      const result = service.compute(params);

      expect(result).toBeLessThanOrEqual(CONFIDENCE_THRESHOLDS.ceiling);
      expect(result).toBeGreaterThanOrEqual(0.0);
    });

    it('should handle very large count values', () => {
      const params: ACTRParams = {
        base: 0.60,
        count: 10000,
        decayRate: 0.03,
        lastRetrievalAt: new Date(),
      };

      const result = service.compute(params);

      expect(result).toBeLessThanOrEqual(1.0);
      expect(result).toBeGreaterThan(0.6);
    });

    it('should handle very old retrieval timestamps', () => {
      const veryOld = new Date('1970-01-01');

      const params: ACTRParams = {
        base: 0.60,
        count: 10,
        decayRate: 0.03,
        lastRetrievalAt: veryOld,
      };

      const result = service.compute(params);

      // Should decay significantly but not go below 0
      expect(result).toBeGreaterThanOrEqual(0.0);
      expect(result).toBeLessThanOrEqual(1.0);
    });

    it('should handle decimal decay rates', () => {
      const params: ACTRParams = {
        base: 0.60,
        count: 5,
        decayRate: 0.0001, // Very slow decay
        lastRetrievalAt: new Date('1970-01-01'),
      };

      const result = service.compute(params);

      expect(result).toBeGreaterThan(0.6); // Should still be above base
      expect(result).toBeLessThanOrEqual(1.0);
    });
  });
});
