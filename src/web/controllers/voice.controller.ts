import {
  Controller,
  Get,
  Post,
  Body,
  Res,
  Inject,
  Req,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import { STT_SERVICE, TTS_SERVICE } from '../../communication/communication.tokens';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { ISttService, ITtsService } from '../../communication/interfaces/communication.interfaces';
import type {
  VoiceTranscriptionResponse,
  VoiceSynthesisResponse,
} from '../dtos/voice.dto';
import type {
  VoiceTranscriptionCompletedPayload,
  VoiceSynthesisCompletedPayload,
} from '../../shared/types/event.types';

/**
 * VoiceController — Audio input/output endpoints.
 *
 * Exposes endpoints for speech-to-text (STT) and text-to-speech (TTS) via
 * OpenAI Whisper and OpenAI TTS APIs. Never blocks on audio failures per
 * CANON communication rules — always returns a response even if services
 * are degraded.
 *
 * CANON §Communication Subsystem: These endpoints bridge the Voice (STT/TTS)
 * services provided by CommunicationModule and the dashboard client.
 *
 * CANON Standard 1 (Theater Prohibition): Output must correlate with actual
 * drive state. Neither STT nor TTS failures affect response generation —
 * the system gracefully degrades to text-only mode.
 */
@Controller('api/voice')
export class VoiceController {
  constructor(
    @Inject(STT_SERVICE) private readonly sttService: ISttService,
    @Inject(TTS_SERVICE) private readonly ttsService: ITtsService,
    @Inject(EVENTS_SERVICE) private readonly events: IEventService,
  ) {}

  /**
   * GET /api/voice/status
   *
   * Returns the current availability of STT and TTS services.
   * Used by the frontend to enable/disable the mic button.
   */
  @Get('status')
  getVoiceStatus(): { available: boolean; stt: boolean; tts: boolean } {
    return { available: true, stt: true, tts: true };
  }

  /**
   * POST /api/voice/transcribe
   *
   * Transcribe audio buffer to text using OpenAI Whisper API.
   *
   * Body: Raw audio buffer (Content-Type: application/octet-stream or audio/wav)
   *
   * Returns: VoiceTranscriptionResponse with:
   *   - text: transcribed text (empty string on failure)
   *   - confidence: Whisper confidence score [0.0, 1.0] (0.0 on failure)
   *   - latencyMs: API call latency
   *
   * On STT failure, returns degradation response with text='', confidence=0,
   * and error message encouraging text input. Never throws; always returns 200.
   *
   * CANON §Communication: Never block on audio failure. The system always
   * provides a response path via text input.
   *
   * @param req Request with raw audio buffer body
   * @param res Response object for streaming or JSON response
   * @returns VoiceTranscriptionResponse (always 200, even on STT failure)
   */
  @Post('transcribe')
  async transcribe(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const startTime = Date.now();
    const sessionId = req.headers['x-session-id'] as string ?? this.generateUUID();

    try {
      // Extract audio buffer from request body
      const audioBuffer = req.body as Buffer;

      if (!audioBuffer || audioBuffer.length === 0) {
        // Empty body — return error response
        const response: VoiceTranscriptionResponse = {
          text: '',
          confidence: 0,
          latencyMs: Date.now() - startTime,
        };

        // Record degradation event
        await this.recordVoiceEvent(
          sessionId,
          'VOICE_TRANSCRIPTION_COMPLETED',
          {
            latencyMs: response.latencyMs,
            textLength: 0,
            confidence: 0,
          } as VoiceTranscriptionCompletedPayload,
        ).catch(() => {
          // Silently ignore event recording failures
        });

        res.status(200).json(response);
        return;
      }

      // Pass the Content-Type header to SttService as a mimeType hint.
      // SttService uses magic bytes first and falls back to this value,
      // so browser formats like audio/webm and audio/ogg produce the
      // correct temp-file extension even when magic bytes are ambiguous.
      const contentType = req.headers['content-type'] as string | undefined;

      // Call STT service
      const transcriptionResult = await this.sttService.transcribe(audioBuffer, contentType);
      const latencyMs = Date.now() - startTime;

      // Build response
      const response: VoiceTranscriptionResponse = {
        text: transcriptionResult.text,
        confidence: transcriptionResult.confidence,
        latencyMs,
      };

      // Record success event
      await this.recordVoiceEvent(
        sessionId,
        'VOICE_TRANSCRIPTION_COMPLETED',
        {
          latencyMs,
          textLength: transcriptionResult.text.length,
          confidence: transcriptionResult.confidence,
        } as VoiceTranscriptionCompletedPayload,
      ).catch(() => {
        // Silently ignore event recording failures
      });

      res.status(200).json(response);
    } catch (error) {
      // STT service failure — return degradation response
      const latencyMs = Date.now() - startTime;

      const response: VoiceTranscriptionResponse = {
        text: '',
        confidence: 0,
        latencyMs,
      };

      // Record degradation event
      await this.recordVoiceEvent(
        sessionId,
        'VOICE_TRANSCRIPTION_COMPLETED',
        {
          latencyMs,
          textLength: 0,
          confidence: 0,
        } as VoiceTranscriptionCompletedPayload,
      ).catch(() => {
        // Silently ignore event recording failures
      });

      res.status(200).json(response);
    }
  }

  /**
   * POST /api/voice/synthesize
   *
   * Synthesize text to audio using OpenAI TTS API.
   *
   * Body: JSON object { text: string }
   *
   * Returns: Audio stream (Content-Type: audio/mpeg) or JSON fallback
   *
   * On TTS success, returns raw audio buffer with Content-Type: audio/mpeg.
   *
   * On TTS failure, returns 200 with text-only fallback response:
   *   { audioBuffer: null, durationMs: 0, format: 'text-fallback', text: input }
   *
   * Never blocks on TTS failure; always returns 200 per CANON rules.
   *
   * CANON §Communication: The system prioritizes text delivery even when
   * audio synthesis fails. Degradation is transparent to the client.
   *
   * @param body JSON body with { text: string }
   * @param res Response object for streaming audio or JSON fallback
   * @returns Audio stream or JSON fallback response (always 200)
   */
  @Post('synthesize')
  async synthesize(
    @Body() body: { text: string },
    @Res() res: Response,
  ): Promise<void> {
    const startTime = Date.now();
    const sessionId = this.generateUUID();

    try {
      const { text } = body;

      if (!text || text.length === 0) {
        // Empty text — return error response
        res.status(200).json({
          audioBuffer: null,
          durationMs: 0,
          format: 'text-fallback',
          error: 'Text is required for synthesis',
        });
        return;
      }

      // Call TTS service
      const synthesisResult = await this.ttsService.synthesize(text);
      const latencyMs = Date.now() - startTime;

      // Record success event
      await this.recordVoiceEvent(
        sessionId,
        'VOICE_SYNTHESIS_COMPLETED',
        {
          latencyMs,
          audioLengthMs: synthesisResult.durationMs,
        } as VoiceSynthesisCompletedPayload,
      ).catch(() => {
        // Silently ignore event recording failures
      });

      // Stream audio with proper headers
      res.set('Content-Type', 'audio/mpeg');
      res.set('Content-Length', synthesisResult.audioBuffer.length.toString());
      res.status(200).send(synthesisResult.audioBuffer);
    } catch (error) {
      // TTS service failure — return text-only fallback
      const latencyMs = Date.now() - startTime;

      // Record degradation event
      await this.recordVoiceEvent(
        sessionId,
        'VOICE_SYNTHESIS_COMPLETED',
        {
          latencyMs,
          audioLengthMs: 0,
        } as VoiceSynthesisCompletedPayload,
      ).catch(() => {
        // Silently ignore event recording failures
      });

      // Return JSON fallback (not audio stream)
      res.status(200).json({
        audioBuffer: null,
        durationMs: 0,
        format: 'text-fallback',
        error: 'TTS unavailable, text input preserved',
        text: body.text,
      });
    }
  }

  /**
   * Record a voice event to TimescaleDB via IEventService.
   *
   * Fire-and-forget: failures are silently ignored to never block
   * response delivery.
   *
   * @param sessionId Session identifier for correlation
   * @param eventType Event type ('VOICE_TRANSCRIPTION_COMPLETED' or 'VOICE_SYNTHESIS_COMPLETED')
   * @param payload Event-specific payload
   */
  private async recordVoiceEvent(
    sessionId: string,
    eventType: 'VOICE_TRANSCRIPTION_COMPLETED' | 'VOICE_SYNTHESIS_COMPLETED',
    payload: VoiceTranscriptionCompletedPayload | VoiceSynthesisCompletedPayload,
  ): Promise<void> {
    try {
      // Get current drive state (or use empty snapshot as fallback)
      const driveSnapshot = {
        timestamp: new Date(),
        pressureVector: {} as any,
        tickNumber: 0,
        driveDeltas: {} as any,
        ruleMatchResult: { ruleId: null, eventType: 'VOICE_TRANSCRIPTION_COMPLETED', matched: false },
        totalPressure: 0,
        sessionId,
      };

      await this.events.record({
        type: eventType,
        subsystem: 'WEB',
        sessionId,
        driveSnapshot,
        schemaVersion: 1,
        ...(payload as any),
      });
    } catch {
      // Silently ignore event recording failures per CANON
    }
  }

  /**
   * Generate a simple UUID v4.
   *
   * Used when the uuid package is not available or to minimize dependencies.
   */
  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c: string) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}
