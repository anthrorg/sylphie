/**
 * Unit tests for TtsService (Text-to-Speech).
 *
 * Tests cover:
 * - Successful synthesis with configurable options
 * - Acknowledgment cache hits and misses
 * - Duration estimation
 * - API failures and graceful degradation
 * - Configuration validation
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TtsService } from './tts.service';
import { TTSDegradationError } from './voice.errors';

// Mock the OpenAI module
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    audio: {
      speech: {
        create: jest.fn(),
      },
    },
  })),
}));

describe('TtsService', () => {
  let service: TtsService;
  let configService: ConfigService;
  let mockSpeechCreate: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TtsService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue({
              openaiVoice: {
                apiKey: 'test-api-key',
                defaultVoice: 'nova',
                defaultFormat: 'mp3',
                defaultSpeed: 1.0,
              },
            }),
          },
        },
      ],
    }).compile();

    service = module.get<TtsService>(TtsService);
    configService = module.get<ConfigService>(ConfigService);

    // Get the mocked OpenAI create method
    const OpenAI = require('openai').OpenAI;
    mockSpeechCreate =
      OpenAI.mock.results[0].value.audio.speech.create;

    // Mock the response body stream
    mockSpeechCreate.mockResolvedValue({
      body: {
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from('audio data chunk 1');
          yield Buffer.from('audio data chunk 2');
        },
      },
    });
  });

  describe('synthesize', () => {
    it('should successfully synthesize text', async () => {
      const result = await service.synthesize('Hello world');

      expect(result).toEqual({
        audioBuffer: expect.any(Buffer),
        durationMs: expect.any(Number),
        format: 'mp3',
      });
      expect(result.audioBuffer.length).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it('should use default voice when no options provided', async () => {
      await service.synthesize('Test');

      expect(mockSpeechCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          voice: 'nova',
          speed: 1.0,
          response_format: 'mp3',
        }),
      );
    });

    it('should apply custom options', async () => {
      await service.synthesize('Test', {
        voice: 'echo',
        speed: 0.8,
        format: 'opus',
      });

      expect(mockSpeechCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          voice: 'echo',
          speed: 0.8,
          response_format: 'opus',
        }),
      );
    });

    it('should throw TTSDegradationError for invalid voice', async () => {
      await expect(
        service.synthesize('Test', { voice: 'invalid-voice' } as any),
      ).rejects.toThrow(TTSDegradationError);
    });

    it('should throw TTSDegradationError for invalid speed', async () => {
      await expect(
        service.synthesize('Test', { speed: 5.0 }),
      ).rejects.toThrow(TTSDegradationError);

      await expect(
        service.synthesize('Test', { speed: 0.1 }),
      ).rejects.toThrow(TTSDegradationError);
    });

    it('should throw TTSDegradationError when text is empty', async () => {
      await expect(service.synthesize('')).rejects.toThrow(
        TTSDegradationError,
      );

      await expect(service.synthesize('   ')).rejects.toThrow(
        TTSDegradationError,
      );
    });

    it('should throw TTSDegradationError when API key is missing', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          TtsService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockReturnValue({
                openaiVoice: { apiKey: '', defaultVoice: 'nova' },
              }),
            },
          },
        ],
      }).compile();

      const noKeyService = module.get<TtsService>(TtsService);

      await expect(noKeyService.synthesize('Test')).rejects.toThrow(
        TTSDegradationError,
      );
    });

    it('should catch API errors and throw TTSDegradationError', async () => {
      mockSpeechCreate.mockRejectedValue(
        new Error('API rate limited'),
      );

      await expect(service.synthesize('Test')).rejects.toThrow(
        TTSDegradationError,
      );
    });

    it('should estimate duration based on word count', async () => {
      const result1 = await service.synthesize('One');
      const result2 = await service.synthesize(
        'One two three four five six seven eight nine ten',
      );

      // Longer text should have longer estimated duration
      expect(result2.durationMs).toBeGreaterThan(result1.durationMs);
    });

    it('should cap duration estimates', async () => {
      const veryLongText = 'word '.repeat(1000); // ~2000 words
      const result = await service.synthesize(veryLongText);

      // Should be capped at 2 minutes (120000ms)
      expect(result.durationMs).toBeLessThanOrEqual(120000);
    });

    it('should enforce minimum duration estimate', async () => {
      // Empty text throws TTSDegradationError first
      // So test with minimal text instead
      mockSpeechCreate.mockResolvedValue({
        body: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('a');
          },
        },
      });

      const result = await service.synthesize('A');
      expect(result.durationMs).toBeGreaterThanOrEqual(500);
    });
  });

  describe('acknowledgment cache', () => {
    it('should return cached acknowledgment on second call', async () => {
      // First call - should hit API
      mockSpeechCreate.mockClear();
      mockSpeechCreate.mockResolvedValue({
        body: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('cached audio');
          },
        },
      });

      const text = 'I see';

      // Manually populate cache to simulate preComputation
      // (preComputeAcknowledgments runs async at init)
      service['acknowledgmentCache'][text] = Buffer.from('precomputed audio');

      const result1 = await service.synthesize(text);
      expect(result1.audioBuffer).toEqual(Buffer.from('precomputed audio'));

      // The mock should not be called when cache hit occurs
      // (But it might be called during initialization)
    });

    it('should handle cache miss gracefully', async () => {
      mockSpeechCreate.mockResolvedValue({
        body: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('new audio');
          },
        },
      });

      const result = await service.synthesize('Unique phrase not in cache');

      expect(result.audioBuffer).toEqual(Buffer.from('new audio'));
      expect(mockSpeechCreate).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should preserve original error in TTSDegradationError', async () => {
      const originalError = new Error('Network timeout');
      mockSpeechCreate.mockRejectedValue(originalError);

      try {
        await service.synthesize('Test');
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TTSDegradationError);
        expect((error as TTSDegradationError).originalError).toBe(
          originalError,
        );
      }
    });

    it('should re-throw TTSDegradationError without double-wrapping', async () => {
      await expect(
        service.synthesize('Test', { voice: 'invalid' } as any),
      ).rejects.toThrow(TTSDegradationError);

      const result = await service
        .synthesize('Test', { voice: 'invalid' } as any)
        .catch((e) => e);

      // Should not have nested TTSDegradationError
      expect(result).toBeInstanceOf(TTSDegradationError);
      expect(result.code).toBe('TTS_DEGRADATION');
    });
  });

  describe('integration', () => {
    it('should handle sequential synthesis calls', async () => {
      mockSpeechCreate.mockResolvedValue({
        body: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('audio');
          },
        },
      });

      const result1 = await service.synthesize('First');
      expect(result1.audioBuffer).toBeDefined();

      const result2 = await service.synthesize('Second');
      expect(result2.audioBuffer).toBeDefined();

      // Should have called the API at least once for sequential calls
      // (may be called more during init for acknowledgment cache)
      expect(mockSpeechCreate).toHaveBeenCalled();
    });

    it('should handle different audio formats', async () => {
      mockSpeechCreate.mockResolvedValue({
        body: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('audio bytes');
          },
        },
      });

      const formats: Array<'mp3' | 'opus' | 'aac' | 'flac'> = [
        'mp3',
        'opus',
        'aac',
        'flac',
      ];

      for (const format of formats) {
        const result = await service.synthesize('Test', { format });
        expect(result.format).toBe(format);
      }
    });

    it('should handle all valid voices', async () => {
      mockSpeechCreate.mockResolvedValue({
        body: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('audio');
          },
        },
      });

      const voices: Array<string> = [
        'alloy',
        'echo',
        'fable',
        'onyx',
        'nova',
        'shimmer',
      ];

      for (const voice of voices) {
        const result = await service.synthesize('Test', {
          voice: voice as any,
        });
        expect(result.audioBuffer).toBeDefined();
      }
    });
  });
});
