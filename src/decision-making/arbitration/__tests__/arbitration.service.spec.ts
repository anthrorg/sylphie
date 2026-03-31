/**
 * Unit tests for ArbitrationService.
 * Tests Type 1, Type 2, and SHRUG selection logic, threshold application, and metrics.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ArbitrationService } from '../arbitration.service';
import { THRESHOLD_COMPUTATION_SERVICE } from '../../decision-making.tokens';
import { EVENTS_SERVICE } from '../../../events/events.tokens';
import { createMockActionCandidate, createMockDriveSnapshot } from '../../__tests__/test-helpers';

describe('ArbitrationService', () => {
  let service: ArbitrationService;
  let mockThresholdService: any;
  let mockEventsService: any;

  beforeEach(async () => {
    mockThresholdService = {
      computeThreshold: jest.fn().mockReturnValue({
        threshold: 0.5,
        baseThreshold: 0.5,
        anxietyMultiplier: 1.0,
        moralMultiplier: 1.0,
        curiosityReduction: 1.0,
        clamped: false,
      }),
    };

    mockEventsService = {
      record: jest.fn().mockResolvedValue({ id: 'test-id', timestamp: new Date() }),
      query: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ArbitrationService,
        {
          provide: THRESHOLD_COMPUTATION_SERVICE,
          useValue: mockThresholdService,
        },
        {
          provide: EVENTS_SERVICE,
          useValue: mockEventsService,
        },
      ],
    }).compile();

    service = module.get<ArbitrationService>(ArbitrationService);
  });

  describe('Empty candidates', () => {
    it('should return SHRUG when no candidates provided', () => {
      const drive = createMockDriveSnapshot();
      const result = service.arbitrate([], drive);

      expect(result.type).toBe('SHRUG');
      if (result.type === 'SHRUG') {
        expect(result.reason).toContain('No action candidates');
      }
    });
  });

  describe('Type 1 selection', () => {
    it('should return TYPE_1 when candidate has procedureData and confidence > 0.80', () => {
      const candidate = createMockActionCandidate({
        procedureData: {
          id: 'proc-1',
          name: 'test-action',
          category: 'Test',
          triggerContext: 'test',
          actionSequence: [],
          provenance: 'LLM_GENERATED',
          confidence: 0.85,
        },
        confidence: 0.85,
      });

      const drive = createMockDriveSnapshot();
      const result = service.arbitrate([candidate], drive);

      expect(result.type).toBe('TYPE_1');
      if (result.type === 'TYPE_1') {
        expect(result.candidate).toBeDefined();
      }
    });

    it('should NOT return TYPE_1 when procedureData is null', () => {
      const candidate = createMockActionCandidate({
        procedureData: null,
        confidence: 0.85,
      });

      const drive = createMockDriveSnapshot();
      const result = service.arbitrate([candidate], drive);

      expect(result.type).not.toBe('TYPE_1');
    });

    it('should NOT return TYPE_1 when confidence <= 0.80', () => {
      const candidate = createMockActionCandidate({
        procedureData: {
          id: 'proc-1',
          name: 'test',
          category: 'Test',
          triggerContext: 'test',
          actionSequence: [],
          provenance: 'LLM_GENERATED',
          confidence: 0.75,
        },
        confidence: 0.75,
      });

      const drive = createMockDriveSnapshot();
      const result = service.arbitrate([candidate], drive);

      expect(result.type).not.toBe('TYPE_1');
    });

    it('should select best Type 1 candidate by highest confidence', () => {
      const candidate1 = createMockActionCandidate({
        procedureData: {
          id: 'proc-1',
          name: 'test1',
          category: 'Test',
          triggerContext: 'test',
          actionSequence: [],
          provenance: 'LLM_GENERATED',
          confidence: 0.90,
        },
        confidence: 0.90,
        contextMatchScore: 0.5,
      });

      const candidate2 = createMockActionCandidate({
        procedureData: {
          id: 'proc-2',
          name: 'test2',
          category: 'Test',
          triggerContext: 'test',
          actionSequence: [],
          provenance: 'LLM_GENERATED',
          confidence: 0.95,
        },
        confidence: 0.95,
        contextMatchScore: 0.5,
      });

      const drive = createMockDriveSnapshot();
      const result = service.arbitrate([candidate1, candidate2], drive);

      expect(result.type).toBe('TYPE_1');
      if (result.type === 'TYPE_1') {
        expect(result.candidate.confidence).toBe(0.95);
      }
    });
  });

  describe('Type 2 selection', () => {
    it('should return TYPE_2 when no Type 1 but qualified candidates above threshold', () => {
      const candidate = createMockActionCandidate({
        procedureData: null,
        confidence: 0.75,
      });

      const drive = createMockDriveSnapshot();
      mockThresholdService.computeThreshold.mockReturnValue({
        threshold: 0.50,
        baseThreshold: 0.50,
        anxietyMultiplier: 1.0,
        moralMultiplier: 1.0,
        curiosityReduction: 1.0,
        clamped: false,
      });

      const result = service.arbitrate([candidate], drive);

      expect(result.type).toBe('TYPE_2');
      if (result.type === 'TYPE_2') {
        expect(result.llmRationale).toBeDefined();
      }
    });

    it('should select best Type 2 candidate by highest confidence', () => {
      const candidate1 = createMockActionCandidate({
        procedureData: null,
        confidence: 0.65,
        contextMatchScore: 0.5,
      });

      const candidate2 = createMockActionCandidate({
        procedureData: null,
        confidence: 0.75,
        contextMatchScore: 0.5,
      });

      const drive = createMockDriveSnapshot();
      const result = service.arbitrate([candidate1, candidate2], drive);

      expect(result.type).toBe('TYPE_2');
      if (result.type === 'TYPE_2') {
        expect(result.candidate.confidence).toBe(0.75);
      }
    });
  });

  describe('SHRUG selection', () => {
    it('should return SHRUG when all candidates below threshold', () => {
      const candidate = createMockActionCandidate({
        procedureData: null,
        confidence: 0.4,
      });

      const drive = createMockDriveSnapshot();
      mockThresholdService.computeThreshold.mockReturnValue({
        threshold: 0.50,
        baseThreshold: 0.50,
        anxietyMultiplier: 1.0,
        moralMultiplier: 1.0,
        curiosityReduction: 1.0,
        clamped: false,
      });

      const result = service.arbitrate([candidate], drive);

      expect(result.type).toBe('SHRUG');
    });

    it('should provide reason when returning SHRUG due to no candidates', () => {
      const drive = createMockDriveSnapshot();
      const result = service.arbitrate([], drive);

      expect(result.type).toBe('SHRUG');
      if (result.type === 'SHRUG') {
        expect(result.reason).toBeDefined();
        expect(result.reason.length).toBeGreaterThan(0);
      }
    });

    it('should provide reason when returning SHRUG due to threshold', () => {
      const candidate = createMockActionCandidate({
        procedureData: null,
        confidence: 0.4,
      });

      const drive = createMockDriveSnapshot();
      mockThresholdService.computeThreshold.mockReturnValue({
        threshold: 0.50,
        baseThreshold: 0.50,
        anxietyMultiplier: 1.0,
        moralMultiplier: 1.0,
        curiosityReduction: 1.0,
        clamped: false,
      });

      const result = service.arbitrate([candidate], drive);

      expect(result.type).toBe('SHRUG');
      if (result.type === 'SHRUG') {
        expect(result.reason).toContain('threshold');
      }
    });
  });

  describe('Threshold application', () => {
    it('should use threshold from threshold service', () => {
      const candidate = createMockActionCandidate({
        procedureData: null,
        confidence: 0.55,
      });

      const drive = createMockDriveSnapshot();
      mockThresholdService.computeThreshold.mockReturnValue({
        threshold: 0.60,
        baseThreshold: 0.50,
        anxietyMultiplier: 1.0,
        moralMultiplier: 1.0,
        curiosityReduction: 1.0,
        clamped: false,
      });

      const result = service.arbitrate([candidate], drive);

      // 0.55 < 0.60, so should be SHRUG
      expect(result.type).toBe('SHRUG');
    });

    it('should accept candidate at or above threshold', () => {
      const candidate = createMockActionCandidate({
        procedureData: null,
        confidence: 0.60,
      });

      const drive = createMockDriveSnapshot();
      mockThresholdService.computeThreshold.mockReturnValue({
        threshold: 0.60,
        baseThreshold: 0.50,
        anxietyMultiplier: 1.0,
        moralMultiplier: 1.0,
        curiosityReduction: 1.0,
        clamped: false,
      });

      const result = service.arbitrate([candidate], drive);

      expect(result.type).toBe('TYPE_2');
    });
  });

  describe('Metrics tracking', () => {
    it('should track TYPE_1 selections', () => {
      const candidate = createMockActionCandidate({
        procedureData: {
          id: 'proc-1',
          name: 'test',
          category: 'Test',
          triggerContext: 'test',
          actionSequence: [],
          provenance: 'LLM_GENERATED',
          confidence: 0.85,
        },
        confidence: 0.85,
      });

      const drive = createMockDriveSnapshot();
      service.arbitrate([candidate], drive);

      const metrics = service.getMetrics();
      expect(metrics.type1Count).toBe(1);
    });

    it('should track TYPE_2 selections', () => {
      const candidate = createMockActionCandidate({
        procedureData: null,
        confidence: 0.75,
      });

      const drive = createMockDriveSnapshot();
      service.arbitrate([candidate], drive);

      const metrics = service.getMetrics();
      expect(metrics.type2Count).toBe(1);
    });

    it('should track SHRUG selections', () => {
      const drive = createMockDriveSnapshot();
      service.arbitrate([], drive);

      const metrics = service.getMetrics();
      expect(metrics.shrugCount).toBe(1);
    });

    it('should compute ratios correctly', () => {
      const drive = createMockDriveSnapshot();

      // 2 Type 1
      for (let i = 0; i < 2; i++) {
        const candidate = createMockActionCandidate({
          procedureData: {
            id: `proc-${i}`,
            name: 'test',
            category: 'Test',
            triggerContext: 'test',
            actionSequence: [],
            provenance: 'LLM_GENERATED',
            confidence: 0.85,
          },
          confidence: 0.85,
        });
        service.arbitrate([candidate], drive);
      }

      // 1 Type 2
      const candidate2 = createMockActionCandidate({
        procedureData: null,
        confidence: 0.75,
      });
      service.arbitrate([candidate2], drive);

      // 1 SHRUG
      service.arbitrate([], drive);

      const metrics = service.getMetrics();
      expect(metrics.total).toBe(4);
      expect(metrics.type1Count).toBe(2);
      expect(metrics.type2Count).toBe(1);
      expect(metrics.shrugCount).toBe(1);
      expect(metrics.type1Ratio).toBeCloseTo(0.5, 1);
    });

    it('should reset metrics', () => {
      const candidate = createMockActionCandidate({
        procedureData: {
          id: 'proc-1',
          name: 'test',
          category: 'Test',
          triggerContext: 'test',
          actionSequence: [],
          provenance: 'LLM_GENERATED',
          confidence: 0.85,
        },
        confidence: 0.85,
      });

      const drive = createMockDriveSnapshot();
      service.arbitrate([candidate], drive);

      let metrics = service.getMetrics();
      expect(metrics.type1Count).toBe(1);

      service.resetMetrics();

      metrics = service.getMetrics();
      expect(metrics.type1Count).toBe(0);
      expect(metrics.type2Count).toBe(0);
      expect(metrics.shrugCount).toBe(0);
      expect(metrics.total).toBe(0);
    });
  });

  describe('Event emission', () => {
    it('should emit event on TYPE_1 selection', () => {
      const candidate = createMockActionCandidate({
        procedureData: {
          id: 'proc-1',
          name: 'test',
          category: 'Test',
          triggerContext: 'test',
          actionSequence: [],
          provenance: 'LLM_GENERATED',
          confidence: 0.85,
        },
        confidence: 0.85,
      });

      const drive = createMockDriveSnapshot();
      service.arbitrate([candidate], drive);

      expect(mockEventsService.record).toHaveBeenCalled();
    });

    it('should emit event on TYPE_2 selection', () => {
      const candidate = createMockActionCandidate({
        procedureData: null,
        confidence: 0.75,
      });

      const drive = createMockDriveSnapshot();
      service.arbitrate([candidate], drive);

      expect(mockEventsService.record).toHaveBeenCalled();
    });

    it('should emit event on SHRUG selection', () => {
      const drive = createMockDriveSnapshot();
      service.arbitrate([], drive);

      expect(mockEventsService.record).toHaveBeenCalled();
    });
  });

  describe('Context match tiebreaking', () => {
    it('should tiebreak Type 1 candidates by contextMatchScore', () => {
      const candidate1 = createMockActionCandidate({
        procedureData: {
          id: 'proc-1',
          name: 'test1',
          category: 'Test',
          triggerContext: 'test',
          actionSequence: [],
          provenance: 'LLM_GENERATED',
          confidence: 0.85,
        },
        confidence: 0.85,
        contextMatchScore: 0.5,
      });

      const candidate2 = createMockActionCandidate({
        procedureData: {
          id: 'proc-2',
          name: 'test2',
          category: 'Test',
          triggerContext: 'test',
          actionSequence: [],
          provenance: 'LLM_GENERATED',
          confidence: 0.85,
        },
        confidence: 0.85,
        contextMatchScore: 0.9,
      });

      const drive = createMockDriveSnapshot();
      const result = service.arbitrate([candidate1, candidate2], drive);

      expect(result.type).toBe('TYPE_1');
      if (result.type === 'TYPE_1') {
        expect(result.candidate.contextMatchScore).toBe(0.9);
      }
    });

    it('should tiebreak Type 2 candidates by contextMatchScore', () => {
      const candidate1 = createMockActionCandidate({
        procedureData: null,
        confidence: 0.75,
        contextMatchScore: 0.5,
      });

      const candidate2 = createMockActionCandidate({
        procedureData: null,
        confidence: 0.75,
        contextMatchScore: 0.8,
      });

      const drive = createMockDriveSnapshot();
      const result = service.arbitrate([candidate1, candidate2], drive);

      expect(result.type).toBe('TYPE_2');
      if (result.type === 'TYPE_2') {
        expect(result.candidate.contextMatchScore).toBe(0.8);
      }
    });
  });

  describe('Mixed scenarios', () => {
    it('should prefer Type 1 over Type 2 when both available', () => {
      const type1Candidate = createMockActionCandidate({
        procedureData: {
          id: 'proc-1',
          name: 'test1',
          category: 'Test',
          triggerContext: 'test',
          actionSequence: [],
          provenance: 'LLM_GENERATED',
          confidence: 0.85,
        },
        confidence: 0.85,
      });

      const type2Candidate = createMockActionCandidate({
        procedureData: null,
        confidence: 0.95,
      });

      const drive = createMockDriveSnapshot();
      const result = service.arbitrate([type1Candidate, type2Candidate], drive);

      expect(result.type).toBe('TYPE_1');
    });

    it('should handle many candidates efficiently', () => {
      const candidates = [];
      for (let i = 0; i < 100; i++) {
        candidates.push(
          createMockActionCandidate({
            procedureData: null,
            confidence: Math.random() * 0.9,
          })
        );
      }

      const drive = createMockDriveSnapshot();
      const result = service.arbitrate(candidates, drive);

      // Should complete without error
      expect(result).toBeDefined();
    });
  });
});
