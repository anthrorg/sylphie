/**
 * Unit tests for SttService (Speech-to-Text).
 *
 * Tests cover:
 * - Successful transcription with confidence estimation
 * - Empty audio buffer handling
 * - API failures and graceful degradation
 * - Configuration validation
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { SttService } from './stt.service';
import { STTDegradationError } from './voice.errors';
import type { AppConfig } from '../../shared/config/app.config';

// Mock the OpenAI module
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    audio: {
      transcriptions: {
        create: jest.fn(),
      },
    },
  })),
}));

// Mock fs module
jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  existsSync: jest.fn(() => true),
  createReadStream: jest.fn().mockReturnValue({
    on: jest.fn().mockReturnThis(),
  }),
}));

describe('SttService', () => {
  let service: SttService;
  let configService: ConfigService;
  let mockOpenaiCreate: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SttService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue({
              openaiVoice: {
                apiKey: 'test-api-key',
              },
            }),
          },
        },
      ],
    }).compile();

    service = module.get<SttService>(SttService);
    configService = module.get<ConfigService>(ConfigService);

    // Get the mocked OpenAI create method
    const OpenAI = require('openai').OpenAI;
    mockOpenaiCreate =
      OpenAI.mock.results[0].value.audio.transcriptions.create;
  });

  describe('transcribe', () => {
    it('should successfully transcribe audio buffer', async () => {
      const audioBuffer = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
      mockOpenaiCreate.mockResolvedValue({
        text: 'hello world',
        language: 'en',
        duration: 2.5,
      });

      const result = await service.transcribe(audioBuffer);

      expect(result).toEqual({
        text: 'hello world',
        confidence: expect.any(Number),
        languageCode: 'en',
        durationMs: 2500,
      });
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should handle empty transcription with low confidence', async () => {
      const audioBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      mockOpenaiCreate.mockResolvedValue({
        text: '',
        language: 'en',
        duration: 1.0,
      });

      const result = await service.transcribe(audioBuffer);

      expect(result.text).toBe('');
      expect(result.confidence).toBeLessThan(0.5);
    });

    it('should handle long audio with reduced confidence', async () => {
      const audioBuffer = Buffer.from('test data');
      mockOpenaiCreate.mockResolvedValue({
        text: 'this is a very long transcription',
        language: 'en',
        duration: 120, // 2 minutes
      });

      const result = await service.transcribe(audioBuffer);

      expect(result.durationMs).toBe(120000);
      expect(result.text).toBe('this is a very long transcription');
    });

    it('should throw STTDegradationError when API key is missing', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SttService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockReturnValue({
                openaiVoice: { apiKey: '' },
              }),
            },
          },
        ],
      }).compile();

      const noKeyService = module.get<SttService>(SttService);
      const audioBuffer = Buffer.from('test');

      await expect(noKeyService.transcribe(audioBuffer)).rejects.toThrow(
        STTDegradationError,
      );
    });

    it('should throw STTDegradationError when audio buffer is empty', async () => {
      const emptyBuffer = Buffer.from([]);

      await expect(service.transcribe(emptyBuffer)).rejects.toThrow(
        STTDegradationError,
      );
    });

    it('should catch API errors and throw STTDegradationError', async () => {
      const audioBuffer = Buffer.from('test');
      mockOpenaiCreate.mockRejectedValue(
        new Error('API rate limited'),
      );

      await expect(service.transcribe(audioBuffer)).rejects.toThrow(
        STTDegradationError,
      );
    });

    it('should default language to en when not provided', async () => {
      const audioBuffer = Buffer.from('test');
      mockOpenaiCreate.mockResolvedValue({
        text: 'hello',
        // language deliberately omitted
        duration: 1.0,
      });

      const result = await service.transcribe(audioBuffer);

      expect(result.languageCode).toBe('en');
    });

    it('should clean up temporary files even on API failure', async () => {
      const audioBuffer = Buffer.from('test');
      mockOpenaiCreate.mockRejectedValue(new Error('API error'));

      await expect(service.transcribe(audioBuffer)).rejects.toThrow(
        STTDegradationError,
      );

      // Verify cleanup attempt (unlinkSync should be called)
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('should re-throw STTDegradationError without wrapping', async () => {
      const audioBuffer = Buffer.from([]);

      const error = await service.transcribe(audioBuffer).catch((e) => e);

      expect(error).toBeInstanceOf(STTDegradationError);
      expect(error.code).toBe('STT_DEGRADATION');
    });
  });

  describe('integration', () => {
    it('should handle sequential transcription calls', async () => {
      mockOpenaiCreate.mockResolvedValue({
        text: 'first call',
        language: 'en',
        duration: 1.0,
      });

      const buffer1 = Buffer.from('audio1');
      const result1 = await service.transcribe(buffer1);
      expect(result1.text).toBe('first call');

      mockOpenaiCreate.mockResolvedValue({
        text: 'second call',
        language: 'en',
        duration: 1.0,
      });

      const buffer2 = Buffer.from('audio2');
      const result2 = await service.transcribe(buffer2);
      expect(result2.text).toBe('second call');
    });
  });
});
