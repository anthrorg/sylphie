/**
 * DeepgramSttService — transcribes audio buffers via the Deepgram API.
 *
 * Implements ISttService. Drop-in replacement for the OpenAI Whisper-based
 * SttService. Called early in the handleGuardianInput() pipeline when
 * voiceBuffer is present on the GuardianInput.
 *
 * CANON §Communication: Voice is the preferred channel, not the only channel.
 * STT failures never block system operation (graceful degradation).
 *
 * Deepgram advantages:
 *   - Real-time and pre-recorded transcription
 *   - Per-word confidence scores (no guessing like Whisper)
 *   - Language detection built-in
 *   - Direct buffer upload (no temp file needed)
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  ISttService,
  TranscriptionResult,
} from '../interfaces/communication.interfaces';
import type { AppConfig } from '../../shared/config/app.config';
import { STTDegradationError } from './voice.errors';

@Injectable()
export class DeepgramSttService implements ISttService {
  private readonly logger = new Logger(DeepgramSttService.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'https://api.deepgram.com/v1/listen';

  constructor(private readonly config: ConfigService) {
    const appConfig = this.config.get<AppConfig>('app');
    this.apiKey = appConfig?.deepgram?.apiKey ?? '';

    if (!this.apiKey) {
      this.logger.warn(
        'DEEPGRAM_API_KEY not configured. STT will fail at runtime.',
      );
    }
  }

  /**
   * Determine the Content-Type for the Deepgram API from the buffer or MIME hint.
   */
  private detectContentType(buf: Buffer, mimeType?: string): string {
    if (mimeType) return mimeType;

    if (buf.length < 4) return 'audio/webm';

    // WebM
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
      return 'audio/webm';
    }
    // OGG
    if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
      return 'audio/ogg';
    }
    // WAV
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
      return 'audio/wav';
    }
    // MP3
    if (
      (buf[0] === 0xff && (buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2)) ||
      (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33)
    ) {
      return 'audio/mpeg';
    }

    return 'audio/webm';
  }

  async transcribe(
    audioBuffer: Buffer,
    mimeType?: string,
  ): Promise<TranscriptionResult> {
    try {
      if (!this.apiKey) {
        throw new STTDegradationError(
          'Deepgram API key not configured. Set DEEPGRAM_API_KEY environment variable.',
        );
      }

      if (audioBuffer.length === 0) {
        throw new STTDegradationError('Audio buffer is empty');
      }

      const contentType = this.detectContentType(audioBuffer, mimeType);

      const params = new URLSearchParams({
        model: 'nova-2',
        language: 'en',
        punctuate: 'true',
        smart_format: 'true',
      });

      const response = await fetch(`${this.baseUrl}?${params}`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          'Content-Type': contentType,
        },
        body: audioBuffer,
      });

      if (!response.ok) {
        throw new STTDegradationError(
          `Deepgram API error: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as DeepgramResponse;

      const channel = data.results?.channels?.[0];
      const alternative = channel?.alternatives?.[0];

      if (!alternative) {
        throw new STTDegradationError('No transcription alternatives in Deepgram response');
      }

      const text = alternative.transcript ?? '';
      const confidence = alternative.confidence ?? 0.7;
      const detectedLanguage = channel?.detected_language ?? 'en';
      const durationMs = Math.round((data.metadata?.duration ?? 0) * 1000);

      return {
        text,
        confidence,
        languageCode: detectedLanguage,
        durationMs,
      };
    } catch (error) {
      if (error instanceof STTDegradationError) {
        this.logger.error(`STT degradation: ${error.message}`);
        throw error;
      }

      const message = `Deepgram API failed: ${error instanceof Error ? error.message : String(error)}`;
      this.logger.error(message);
      throw new STTDegradationError(
        message,
        error instanceof Error ? error : undefined,
      );
    }
  }
}

// Deepgram response shape (minimal)
interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{
        transcript?: string;
        confidence?: number;
      }>;
    }>;
  };
}
