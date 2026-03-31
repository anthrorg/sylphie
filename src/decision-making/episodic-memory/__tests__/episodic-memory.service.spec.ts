/**
 * Unit tests for EpisodicMemoryService.
 * Tests ring buffer, encoding gates, Jaccard similarity, and ACT-R decay.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EpisodicMemoryService } from '../episodic-memory.service';
import { EVENTS_SERVICE } from '../../../events/events.tokens';
import { createMockEpisodeInput, createMockDriveSnapshot } from '../../__tests__/test-helpers';

describe('EpisodicMemoryService', () => {
  let service: EpisodicMemoryService;
  let mockEventsService: any;

  beforeEach(async () => {
    mockEventsService = {
      record: jest.fn().mockResolvedValue({ id: 'test-id', timestamp: new Date() }),
      query: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EpisodicMemoryService,
        {
          provide: EVENTS_SERVICE,
          useValue: mockEventsService,
        },
      ],
    }).compile();

    service = module.get<EpisodicMemoryService>(EpisodicMemoryService);
  });

  describe('encode()', () => {
    it('should return null when depth is SKIP', async () => {
      const input = createMockEpisodeInput();
      const result = await service.encode(input, 'SKIP');
      expect(result).toBeNull();
    });

    it('should return null when encoding gate fails (attention and arousal both <= 0.6)', async () => {
      const input = createMockEpisodeInput({ attention: 0.5, arousal: 0.5 });
      const result = await service.encode(input, 'NORMAL');
      expect(result).toBeNull();
    });

    it('should encode when attention > 0.6', async () => {
      const input = createMockEpisodeInput({ attention: 0.65, arousal: 0.5 });
      const result = await service.encode(input, 'NORMAL');
      expect(result).not.toBeNull();
      expect(result?.id).toBeDefined();
    });

    it('should encode when arousal > 0.6', async () => {
      const input = createMockEpisodeInput({ attention: 0.5, arousal: 0.65 });
      const result = await service.encode(input, 'NORMAL');
      expect(result).not.toBeNull();
      expect(result?.id).toBeDefined();
    });

    it('should encode when both attention and arousal > 0.6', async () => {
      const input = createMockEpisodeInput({ attention: 0.65, arousal: 0.65 });
      const result = await service.encode(input, 'NORMAL');
      expect(result).not.toBeNull();
    });

    it('should compute ageWeight as attention * exp(0) at encoding time', async () => {
      const input = createMockEpisodeInput({ attention: 0.8, arousal: 0.7 });
      const result = await service.encode(input, 'NORMAL');
      expect(result?.ageWeight).toBeCloseTo(0.8, 5);
    });

    it('should store all fields for NORMAL depth', async () => {
      const input = createMockEpisodeInput({ attention: 0.7, arousal: 0.7 });
      const result = await service.encode(input, 'NORMAL');
      expect(result?.driveSnapshot).toBeDefined();
      expect(result?.inputSummary).toBe(input.inputSummary);
      expect(result?.actionTaken).toBe(input.actionTaken);
      expect(result?.contextFingerprint).toBe(input.contextFingerprint);
    });

    it('should emit EPISODE_ENCODED event for NORMAL depth', async () => {
      const input = createMockEpisodeInput({ attention: 0.7, arousal: 0.7 });
      await service.encode(input, 'NORMAL');
      expect(mockEventsService.record).toHaveBeenCalled();
    });

    it('should not throw when event emission fails', async () => {
      mockEventsService.record.mockRejectedValueOnce(new Error('Event service error'));
      const input = createMockEpisodeInput({ attention: 0.7, arousal: 0.7 });
      const result = await service.encode(input, 'NORMAL');
      expect(result).not.toBeNull();
    });
  });

  describe('Ring buffer management', () => {
    it('should start with 0 episodes', () => {
      expect(service.getEpisodeCount()).toBe(0);
    });

    it('should add episodes sequentially until capacity', async () => {
      for (let i = 0; i < 50; i++) {
        const input = createMockEpisodeInput({ attention: 0.7, arousal: 0.7 });
        await service.encode(input, 'NORMAL');
      }
      expect(service.getEpisodeCount()).toBe(50);
    });

    it('should overflow FIFO when exceeding capacity (51st episode)', async () => {
      for (let i = 0; i < 51; i++) {
        const input = createMockEpisodeInput({ attention: 0.7, arousal: 0.7 });
        await service.encode(input, 'NORMAL');
      }
      expect(service.getEpisodeCount()).toBe(50);
    });

    it('should maintain buffer at exactly 50 after many overflows', async () => {
      for (let i = 0; i < 100; i++) {
        const input = createMockEpisodeInput({ attention: 0.7, arousal: 0.7 });
        await service.encode(input, 'NORMAL');
      }
      expect(service.getEpisodeCount()).toBe(50);
    });
  });

  describe('getRecentEpisodes()', () => {
    it('should return empty array when no episodes', () => {
      const episodes = service.getRecentEpisodes();
      expect(episodes).toEqual([]);
    });

    it('should return newest episodes first', async () => {
      const input1 = createMockEpisodeInput({ attention: 0.7, arousal: 0.7, inputSummary: 'First' });
      const input2 = createMockEpisodeInput({ attention: 0.7, arousal: 0.7, inputSummary: 'Second' });
      const input3 = createMockEpisodeInput({ attention: 0.7, arousal: 0.7, inputSummary: 'Third' });

      await service.encode(input1, 'NORMAL');
      await new Promise((r) => setTimeout(r, 10));
      await service.encode(input2, 'NORMAL');
      await new Promise((r) => setTimeout(r, 10));
      await service.encode(input3, 'NORMAL');

      const episodes = service.getRecentEpisodes();
      expect(episodes[0].inputSummary).toBe('Third');
      expect(episodes[1].inputSummary).toBe('Second');
      expect(episodes[2].inputSummary).toBe('First');
    });

    it('should respect count limit', async () => {
      for (let i = 0; i < 10; i++) {
        const input = createMockEpisodeInput({ attention: 0.7, arousal: 0.7, inputSummary: `Episode ${i}` });
        await service.encode(input, 'NORMAL');
      }

      const episodes = service.getRecentEpisodes(5);
      expect(episodes.length).toBe(5);
    });

    it('should return default 10 episodes when no count specified', async () => {
      for (let i = 0; i < 15; i++) {
        const input = createMockEpisodeInput({ attention: 0.7, arousal: 0.7 });
        await service.encode(input, 'NORMAL');
      }

      const episodes = service.getRecentEpisodes();
      expect(episodes.length).toBe(10);
    });
  });

  describe('queryByContext()', () => {
    it('should return empty array when no episodes', () => {
      const episodes = service.queryByContext('test context');
      expect(episodes).toEqual([]);
    });

    it('should return episodes with Jaccard similarity > 0.7', async () => {
      const input1 = createMockEpisodeInput({
        attention: 0.7,
        arousal: 0.7,
        contextFingerprint: 'apple banana cherry',
      });
      const input2 = createMockEpisodeInput({
        attention: 0.7,
        arousal: 0.7,
        contextFingerprint: 'apple banana dog',
      });
      const input3 = createMockEpisodeInput({
        attention: 0.7,
        arousal: 0.7,
        contextFingerprint: 'xyz abc def',
      });

      await service.encode(input1, 'NORMAL');
      await service.encode(input2, 'NORMAL');
      await service.encode(input3, 'NORMAL');

      const episodes = service.queryByContext('apple banana cherry');
      // Should match input1 (identical) and input2 (high similarity)
      expect(episodes.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter results below similarity threshold', async () => {
      const input1 = createMockEpisodeInput({
        attention: 0.7,
        arousal: 0.7,
        contextFingerprint: 'apple banana cherry',
      });
      const input2 = createMockEpisodeInput({
        attention: 0.7,
        arousal: 0.7,
        contextFingerprint: 'xyz abc def ghi',
      });

      await service.encode(input1, 'NORMAL');
      await service.encode(input2, 'NORMAL');

      const episodes = service.queryByContext('apple banana cherry');
      // Should only match input1, not input2 (no overlap)
      expect(episodes.length).toBe(1);
      expect(episodes[0].contextFingerprint).toContain('apple');
    });

    it('should sort results by ageWeight descending', async () => {
      const input1 = createMockEpisodeInput({
        attention: 0.3,
        arousal: 0.7,
        contextFingerprint: 'test data',
      });
      const input2 = createMockEpisodeInput({
        attention: 0.8,
        arousal: 0.7,
        contextFingerprint: 'test sample',
      });

      await service.encode(input1, 'NORMAL');
      await service.encode(input2, 'NORMAL');

      const episodes = service.queryByContext('test data');
      if (episodes.length > 1) {
        expect(episodes[0].ageWeight).toBeGreaterThanOrEqual(episodes[1].ageWeight);
      }
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        const input = createMockEpisodeInput({
          attention: 0.7,
          arousal: 0.7,
          contextFingerprint: 'test similar data',
        });
        await service.encode(input, 'NORMAL');
      }

      const episodes = service.queryByContext('test similar data', 2);
      expect(episodes.length).toBeLessThanOrEqual(2);
    });

    it('should use default limit of 5 when not specified', async () => {
      for (let i = 0; i < 10; i++) {
        const input = createMockEpisodeInput({
          attention: 0.7,
          arousal: 0.7,
          contextFingerprint: 'test context sample',
        });
        await service.encode(input, 'NORMAL');
      }

      const episodes = service.queryByContext('test context sample');
      expect(episodes.length).toBeLessThanOrEqual(5);
    });
  });

  describe('getEpisodeCount()', () => {
    it('should return 0 for empty buffer', () => {
      expect(service.getEpisodeCount()).toBe(0);
    });

    it('should return count after encoding episodes', async () => {
      const input = createMockEpisodeInput({ attention: 0.7, arousal: 0.7 });
      await service.encode(input, 'NORMAL');
      expect(service.getEpisodeCount()).toBe(1);
    });

    it('should return correct count with multiple episodes', async () => {
      for (let i = 0; i < 5; i++) {
        const input = createMockEpisodeInput({ attention: 0.7, arousal: 0.7 });
        await service.encode(input, 'NORMAL');
      }
      expect(service.getEpisodeCount()).toBe(5);
    });

    it('should cap at ring buffer capacity (50)', async () => {
      for (let i = 0; i < 100; i++) {
        const input = createMockEpisodeInput({ attention: 0.7, arousal: 0.7 });
        await service.encode(input, 'NORMAL');
      }
      expect(service.getEpisodeCount()).toBe(50);
    });
  });

  describe('Encoding depth variants', () => {
    it('should handle DEEP encoding', async () => {
      const input = createMockEpisodeInput({ attention: 0.7, arousal: 0.9 });
      const result = await service.encode(input, 'DEEP');
      expect(result?.encodingDepth).toBe('DEEP');
    });

    it('should handle SHALLOW encoding', async () => {
      const input = createMockEpisodeInput({ attention: 0.7, arousal: 0.7 });
      const result = await service.encode(input, 'SHALLOW');
      expect(result?.encodingDepth).toBe('SHALLOW');
    });

    it('should handle NORMAL encoding', async () => {
      const input = createMockEpisodeInput({ attention: 0.7, arousal: 0.7 });
      const result = await service.encode(input, 'NORMAL');
      expect(result?.encodingDepth).toBe('NORMAL');
    });
  });

  describe('ACT-R Confidence and ageWeight', () => {
    it('should set ageWeight equal to attention at encoding (exp(0))', async () => {
      const attentionValue = 0.75;
      const input = createMockEpisodeInput({ attention: attentionValue, arousal: 0.7 });
      const result = await service.encode(input, 'NORMAL');
      expect(result?.ageWeight).toBeCloseTo(attentionValue, 5);
    });

    it('should generate unique episode IDs', async () => {
      const input1 = createMockEpisodeInput({ attention: 0.7, arousal: 0.7 });
      const input2 = createMockEpisodeInput({ attention: 0.7, arousal: 0.7 });

      const result1 = await service.encode(input1, 'NORMAL');
      const result2 = await service.encode(input2, 'NORMAL');

      expect(result1?.id).not.toBe(result2?.id);
    });
  });
});
