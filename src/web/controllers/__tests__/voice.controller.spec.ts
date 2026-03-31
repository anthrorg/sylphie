/**
 * Unit tests for VoiceController.
 *
 * Tests cover:
 * - Transcribe delegates to ISttService
 * - Synthesize delegates to ITtsService
 * - STT failure returns graceful degradation response
 * - TTS failure returns text-only fallback
 * - Events recorded for both endpoints
 */

import { VoiceController } from '../voice.controller';
import { EVENTS_SERVICE } from '../../../events/events.tokens';
import { STT_SERVICE, TTS_SERVICE } from '../../../communication/communication.tokens';
import type { IEventService } from '../../../events/interfaces/events.interfaces';
import type { ISttService, ITtsService } from '../../../communication/interfaces/communication.interfaces';

describe('VoiceController', () => {
  let controller: VoiceController;
  let mockSttService: jest.Mocked<ISttService>;
  let mockTtsService: jest.Mocked<ITtsService>;
  let mockEventService: jest.Mocked<IEventService>;
  let mockRes: any;

  const createMockResponse = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  });

  const createMockRequest = (body: any = null) => ({
    body,
    headers: {},
  } as any);

  beforeEach(() => {
    mockSttService = {
      transcribe: jest.fn(),
    } as any;

    mockTtsService = {
      synthesize: jest.fn(),
    } as any;

    mockEventService = {
      record: jest.fn().mockResolvedValue({ id: 'evt-1', success: true }),
    } as any;

    controller = new VoiceController(
      mockSttService,
      mockTtsService,
      mockEventService,
    );

    mockRes = createMockResponse();
  });

  describe('transcribe', () => {
    it('should call STT service with audio buffer', async () => {
      // Arrange
      const audioBuffer = Buffer.from('audio data');
      const mockReq = createMockRequest(audioBuffer);
      mockSttService.transcribe.mockResolvedValue({
        text: 'Hello world',
        confidence: 0.95,
        languageCode: 'en',
        durationMs: 2000,
      });

      // Act
      await controller.transcribe(mockReq, mockRes);

      // Assert
      expect(mockSttService.transcribe).toHaveBeenCalledWith(audioBuffer);
    });

    it('should return transcribed text in response', async () => {
      // Arrange
      const audioBuffer = Buffer.from('audio data');
      const mockReq = createMockRequest(audioBuffer);
      mockSttService.transcribe.mockResolvedValue({
        text: 'Hello world',
        confidence: 0.95,
        languageCode: 'en',
        durationMs: 2000,
      });

      // Act
      await controller.transcribe(mockReq, mockRes);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalled();

      const response = mockRes.json.mock.calls[0][0];
      expect(response.text).toBe('Hello world');
      expect(response.confidence).toBe(0.95);
    });

    it('should include latency in response', async () => {
      // Arrange
      const audioBuffer = Buffer.from('audio data');
      const mockReq = createMockRequest(audioBuffer);
      mockSttService.transcribe.mockResolvedValue({
        text: 'Hello',
        confidence: 0.9,
        languageCode: 'en',
        durationMs: 1000,
      });
      mockSttService.transcribe.mockResolvedValue({
        text: 'Hello',
        confidence: 0.9,
        languageCode: 'en',
        durationMs: 1000,
      });
      mockSttService.transcribe.mockResolvedValue({
        text: 'Hello',
        confidence: 0.9,
        languageCode: 'en',
        durationMs: 1000,
      });
      mockSttService.transcribe.mockResolvedValue({
        text: 'Hello',
        confidence: 0.9,
        languageCode: 'en',
        durationMs: 1000,
      });

      // Act
      await controller.transcribe(mockReq, mockRes);

      // Assert
      const response = mockRes.json.mock.calls[0][0];
      expect(response.latencyMs).toBeDefined();
      expect(typeof response.latencyMs).toBe('number');
      expect(response.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should return degradation response on empty buffer', async () => {
      // Arrange
      const audioBuffer = Buffer.from('');
      const mockReq = createMockRequest(audioBuffer);

      // Act
      await controller.transcribe(mockReq, mockRes);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(200);
      const response = mockRes.json.mock.calls[0][0];
      expect(response.text).toBe('');
      expect(response.confidence).toBe(0);
    });

    it('should return degradation response on null body', async () => {
      // Arrange
      const mockReq = createMockRequest(null);

      // Act
      await controller.transcribe(mockReq, mockRes);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(200);
      const response = mockRes.json.mock.calls[0][0];
      expect(response.text).toBe('');
      expect(response.confidence).toBe(0);
    });

    it('should return degradation response on STT failure', async () => {
      // Arrange
      const audioBuffer = Buffer.from('audio data');
      const mockReq = createMockRequest(audioBuffer);
      mockSttService.transcribe.mockRejectedValue(
        new Error('STT service error'),
      );

      // Act
      await controller.transcribe(mockReq, mockRes);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(200);
      const response = mockRes.json.mock.calls[0][0];
      expect(response.text).toBe('');
      expect(response.confidence).toBe(0);
    });

    it('should record VOICE_TRANSCRIPTION_COMPLETED event on success', async () => {
      // Arrange
      const audioBuffer = Buffer.from('audio data');
      const mockReq = createMockRequest(audioBuffer);
      mockSttService.transcribe.mockResolvedValue({
        text: 'Hello',
        confidence: 0.95,
        languageCode: 'en',
        durationMs: 1000,
      });

      // Act
      await controller.transcribe(mockReq, mockRes);

      // Assert
      expect(mockEventService.record).toHaveBeenCalled();
      const eventCall = mockEventService.record.mock.calls[0][0];
      expect(eventCall.type).toBe('VOICE_TRANSCRIPTION_COMPLETED');
      expect(eventCall.subsystem).toBe('WEB');
    });

    it('should record event on transcription failure', async () => {
      // Arrange
      const audioBuffer = Buffer.from('audio data');
      const mockReq = createMockRequest(audioBuffer);
      mockSttService.transcribe.mockRejectedValue(new Error('STT failed'));

      // Act
      await controller.transcribe(mockReq, mockRes);

      // Assert
      expect(mockEventService.record).toHaveBeenCalled();
      const eventCall = mockEventService.record.mock.calls[0][0];
      expect(eventCall.type).toBe('VOICE_TRANSCRIPTION_COMPLETED');
    });

    it('should not fail response if event recording fails', async () => {
      // Arrange
      const audioBuffer = Buffer.from('audio data');
      const mockReq = createMockRequest(audioBuffer);
      mockSttService.transcribe.mockResolvedValue({
        text: 'Hello',
        confidence: 0.95,
        languageCode: 'en',
        durationMs: 1000,
      });
      mockEventService.record.mockRejectedValue(
        new Error('Event service error'),
      );

      // Act
      await controller.transcribe(mockReq, mockRes);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalled();
    });

    it('should use session ID from headers if present', async () => {
      // Arrange
      const audioBuffer = Buffer.from('audio data');
      const mockReq = createMockRequest(audioBuffer);
      mockReq.headers['x-session-id'] = 'session-123';
      mockSttService.transcribe.mockResolvedValue({
        text: 'Hello',
        confidence: 0.95,
        languageCode: 'en',
        durationMs: 1000,
      });

      // Act
      await controller.transcribe(mockReq, mockRes);

      // Assert
      expect(mockEventService.record).toHaveBeenCalled();
      const eventCall = mockEventService.record.mock.calls[0][0];
      expect(eventCall.sessionId).toBe('session-123');
    });
  });

  describe('synthesize', () => {
    it('should call TTS service with text', async () => {
      // Arrange
      const text = 'Hello world';
      mockTtsService.synthesize.mockResolvedValue({
        audioBuffer: Buffer.from('audio'),
        durationMs: 1000,
        format: 'mp3',
      });

      // Act
      await controller.synthesize({ text }, mockRes);

      // Assert
      expect(mockTtsService.synthesize).toHaveBeenCalledWith(text);
    });

    it('should return audio buffer on success', async () => {
      // Arrange
      const audioBuffer = Buffer.from('audio data');
      mockTtsService.synthesize.mockResolvedValue({
        audioBuffer,
        durationMs: 1000,
        format: 'mp3',
      });

      // Act
      await controller.synthesize({ text: 'Hello' }, mockRes);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.send).toHaveBeenCalledWith(audioBuffer);
      expect(mockRes.set).toHaveBeenCalledWith('Content-Type', 'audio/mpeg');
    });

    it('should set proper audio headers on success', async () => {
      // Arrange
      const audioBuffer = Buffer.from('audio data');
      mockTtsService.synthesize.mockResolvedValue({
        audioBuffer,
        durationMs: 1000,
        format: 'mp3',
      });

      // Act
      await controller.synthesize({ text: 'Hello' }, mockRes);

      // Assert
      expect(mockRes.set).toHaveBeenCalledWith(
        'Content-Type',
        'audio/mpeg',
      );
      expect(mockRes.set).toHaveBeenCalledWith(
        'Content-Length',
        audioBuffer.length.toString(),
      );
    });

    it('should return text-only fallback on empty text', async () => {
      // Arrange
      mockRes = createMockResponse();

      // Act
      await controller.synthesize({ text: '' }, mockRes);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalled();

      const response = mockRes.json.mock.calls[0][0];
      expect(response.audioBuffer).toBeNull();
      expect(response.format).toBe('text-fallback');
    });

    it('should return text-only fallback on TTS failure', async () => {
      // Arrange
      mockTtsService.synthesize.mockRejectedValue(
        new Error('TTS service error'),
      );

      // Act
      await controller.synthesize({ text: 'Hello' }, mockRes);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalled();

      const response = mockRes.json.mock.calls[0][0];
      expect(response.audioBuffer).toBeNull();
      expect(response.format).toBe('text-fallback');
      expect(response.text).toBe('Hello');
    });

    it('should record VOICE_SYNTHESIS_COMPLETED event on success', async () => {
      // Arrange
      mockTtsService.synthesize.mockResolvedValue({
        audioBuffer: Buffer.from('audio'),
        durationMs: 1000,
        format: 'mp3',
      });

      // Act
      await controller.synthesize({ text: 'Hello' }, mockRes);

      // Assert
      expect(mockEventService.record).toHaveBeenCalled();
      const eventCall = mockEventService.record.mock.calls[0][0];
      expect(eventCall.type).toBe('VOICE_SYNTHESIS_COMPLETED');
      expect(eventCall.subsystem).toBe('WEB');
    });

    it('should record event on synthesis failure', async () => {
      // Arrange
      mockTtsService.synthesize.mockRejectedValue(new Error('TTS failed'));

      // Act
      await controller.synthesize({ text: 'Hello' }, mockRes);

      // Assert
      expect(mockEventService.record).toHaveBeenCalled();
      const eventCall = mockEventService.record.mock.calls[0][0];
      expect(eventCall.type).toBe('VOICE_SYNTHESIS_COMPLETED');
    });

    it('should not fail response if event recording fails', async () => {
      // Arrange
      mockTtsService.synthesize.mockResolvedValue({
        audioBuffer: Buffer.from('audio'),
        durationMs: 1000,
        format: 'mp3',
      });
      mockEventService.record.mockRejectedValue(
        new Error('Event service error'),
      );

      // Act
      await controller.synthesize({ text: 'Hello' }, mockRes);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.send).toHaveBeenCalled();
    });

    it('should include audio duration in event payload', async () => {
      // Arrange
      mockTtsService.synthesize.mockResolvedValue({
        audioBuffer: Buffer.from('audio'),
        durationMs: 5000,
        format: 'mp3',
      });

      // Act
      await controller.synthesize({ text: 'Hello' }, mockRes);

      // Assert
      expect(mockEventService.record).toHaveBeenCalled();
      const eventCall = mockEventService.record.mock.calls[0][0];
      expect((eventCall as any).audioLengthMs).toBe(5000);
    });
  });

  describe('graceful degradation', () => {
    it('should always return 200 status code on transcription', async () => {
      // Arrange
      mockSttService.transcribe.mockRejectedValue(new Error('Any error'));

      // Act
      const mockReq = createMockRequest(Buffer.from('audio'));
      await controller.transcribe(mockReq, mockRes);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it('should always return 200 status code on synthesis', async () => {
      // Arrange
      mockTtsService.synthesize.mockRejectedValue(new Error('Any error'));

      // Act
      await controller.synthesize({ text: 'Hello' }, mockRes);

      // Assert
      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it('should provide text fallback in synthesis error case', async () => {
      // Arrange
      mockTtsService.synthesize.mockRejectedValue(
        new Error('TTS unavailable'),
      );

      // Act
      await controller.synthesize({ text: 'Important message' }, mockRes);

      // Assert
      const response = mockRes.json.mock.calls[0][0];
      expect(response.text).toBe('Important message');
      expect(response.format).toBe('text-fallback');
    });
  });

  describe('event payload accuracy', () => {
    it('should record correct latency in transcription event', async () => {
      // Arrange
      const audioBuffer = Buffer.from('audio');
      const mockReq = createMockRequest(audioBuffer);
      mockSttService.transcribe.mockResolvedValue({
        text: 'Hello',
        confidence: 0.95,
        languageCode: 'en',
        durationMs: 1000,
      });

      // Act
      await controller.transcribe(mockReq, mockRes);

      // Assert
      expect(mockEventService.record).toHaveBeenCalled();
      const eventCall = mockEventService.record.mock.calls[0][0] as any;
      expect(eventCall.latencyMs).toBeDefined();
      expect(typeof eventCall.latencyMs).toBe('number');
      expect(eventCall.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should record text length in transcription event', async () => {
      // Arrange
      const audioBuffer = Buffer.from('audio');
      const mockReq = createMockRequest(audioBuffer);
      mockSttService.transcribe.mockResolvedValue({
        text: 'Hello world',
        confidence: 0.95,
        languageCode: 'en',
        durationMs: 2000,
      });

      // Act
      await controller.transcribe(mockReq, mockRes);

      // Assert
      const eventCall = mockEventService.record.mock.calls[0][0] as any;
      expect(eventCall.textLength).toBe(11);
    });

    it('should record confidence in transcription event', async () => {
      // Arrange
      const audioBuffer = Buffer.from('audio');
      const mockReq = createMockRequest(audioBuffer);
      mockSttService.transcribe.mockResolvedValue({
        text: 'Hello',
        confidence: 0.87,
        languageCode: 'en',
        durationMs: 1000,
      });

      // Act
      await controller.transcribe(mockReq, mockRes);

      // Assert
      const eventCall = mockEventService.record.mock.calls[0][0] as any;
      expect(eventCall.confidence).toBe(0.87);
    });

    it('should record latency in synthesis event', async () => {
      // Arrange
      mockTtsService.synthesize.mockResolvedValue({
        audioBuffer: Buffer.from('audio'),
        durationMs: 2000,
        format: 'mp3',
      });

      // Act
      await controller.synthesize({ text: 'Hello' }, mockRes);

      // Assert
      const eventCall = mockEventService.record.mock.calls[0][0] as any;
      expect(eventCall.latencyMs).toBeDefined();
      expect(typeof eventCall.latencyMs).toBe('number');
    });
  });
});
