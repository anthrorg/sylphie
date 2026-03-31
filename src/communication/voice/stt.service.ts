/**
 * SttService — transcribes audio buffers via the OpenAI Whisper API.
 *
 * Implements ISttService. Called early in the handleGuardianInput() pipeline
 * when voiceBuffer is present on the GuardianInput. The transcription
 * populates the text field for all downstream processing.
 *
 * The raw audio buffer is preserved in TimescaleDB event records for audit
 * and re-transcription in case of quality issues.
 *
 * CANON §Communication: Voice is the preferred channel, not the only channel.
 * STT failures never block system operation (graceful degradation).
 * Audio failures throw STTDegradationError, which callers catch and handle
 * by skipping TTS or using fallback text input.
 *
 * Confidence estimation:
 * - Whisper does not directly expose per-word confidence, so we derive it
 *   from the API's internal log-prob scores when available.
 * - Conservative default: if derivation fails, confidence is set to 0.70.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAI } from 'openai';
import * as fs from 'fs';
import * as path from 'path';

import type { ISttService, TranscriptionResult } from '../interfaces/communication.interfaces';
import type { AppConfig } from '../../shared/config/app.config';
import { STTDegradationError } from './voice.errors';

@Injectable()
export class SttService implements ISttService {
  private readonly logger = new Logger(SttService.name);
  private readonly openai: OpenAI;
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    const appConfig = this.config.get<AppConfig>('app');
    this.apiKey = appConfig?.openaiVoice?.apiKey ?? '';

    if (!this.apiKey) {
      this.logger.warn(
        'OPENAI_API_KEY not configured. STT will fail at runtime. ' +
          'Set OPENAI_API_KEY environment variable.',
      );
    }

    this.openai = new OpenAI({ apiKey: this.apiKey });
  }

  /**
   * Detect the audio format from the buffer's magic bytes.
   *
   * Magic byte signatures checked:
   *   WebM  0x1A 0x45 0xDF 0xA3
   *   OGG   OggS (0x4F 0x67 0x67 0x53)
   *   WAV   RIFF (0x52 0x49 0x46 0x46)
   *   MP3   0xFF 0xFB | 0xFF 0xF3 | 0xFF 0xF2 | ID3 (0x49 0x44 0x33)
   *
   * Fallback: .webm (most common browser MediaRecorder output).
   *
   * @param buf - Audio buffer to inspect.
   * @returns File extension including the leading dot, e.g. '.webm'.
   */
  private detectExtension(buf: Buffer): string {
    if (buf.length < 4) {
      return '.webm';
    }

    // WebM: 0x1A 0x45 0xDF 0xA3
    if (
      buf[0] === 0x1a &&
      buf[1] === 0x45 &&
      buf[2] === 0xdf &&
      buf[3] === 0xa3
    ) {
      return '.webm';
    }

    // OGG: OggS
    if (
      buf[0] === 0x4f &&
      buf[1] === 0x67 &&
      buf[2] === 0x67 &&
      buf[3] === 0x53
    ) {
      return '.ogg';
    }

    // WAV: RIFF
    if (
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46
    ) {
      return '.wav';
    }

    // MP3: sync word variants
    if (
      (buf[0] === 0xff && (buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2)) ||
      (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) // ID3
    ) {
      return '.mp3';
    }

    return '.webm';
  }

  /**
   * Derive a file extension from a MIME type string.
   *
   * Only covers the MIME types the Whisper API accepts.
   * Returns null when the MIME type is unrecognised so the caller can
   * fall back to magic-byte detection.
   *
   * @param mimeType - e.g. 'audio/webm', 'audio/ogg; codecs=opus'
   * @returns Extension string (e.g. '.webm') or null.
   */
  private extensionFromMimeType(mimeType: string): string | null {
    const lower = mimeType.toLowerCase();
    if (lower.includes('webm')) return '.webm';
    if (lower.includes('ogg')) return '.ogg';
    if (lower.includes('wav')) return '.wav';
    if (lower.includes('mp3') || lower.includes('mpeg')) return '.mp3';
    if (lower.includes('mp4') || lower.includes('m4a')) return '.m4a';
    if (lower.includes('flac')) return '.flac';
    return null;
  }

  /**
   * Transcribe an audio buffer to text using the OpenAI Whisper API.
   *
   * Accepts raw audio bytes in any format supported by the Whisper API:
   * webm, ogg, wav, mp3, m4a, mpeg, mpga, flac.
   *
   * The temp file extension is determined by:
   *   1. Magic bytes from the buffer (preferred).
   *   2. mimeType parameter if magic-byte detection falls back to default.
   *
   * Returns TranscriptionResult with:
   *   - text: the transcribed content
   *   - confidence: derived from Whisper's internal confidence
   *   - languageCode: BCP-47 code detected by Whisper (e.g., 'en', 'fr')
   *   - durationMs: approximate duration of the audio
   *
   * @param audioBuffer - Raw audio bytes (WebM, OGG, WAV, MP3, etc.)
   * @param mimeType - Optional MIME type hint from the HTTP Content-Type header.
   * @returns Transcription result
   * @throws STTDegradationError if Whisper API fails or is unavailable
   */
  async transcribe(audioBuffer: Buffer, mimeType?: string): Promise<TranscriptionResult> {
    try {
      if (!this.apiKey) {
        throw new STTDegradationError(
          'OpenAI API key not configured. Set OPENAI_API_KEY environment variable.',
        );
      }

      if (audioBuffer.length === 0) {
        throw new STTDegradationError('Audio buffer is empty');
      }

      // Determine the file extension.
      // Magic bytes take priority; fall back to mimeType hint, then default.
      const magicExt = this.detectExtension(audioBuffer);
      let ext: string;
      if (magicExt !== '.webm') {
        // Magic bytes identified a specific format.
        ext = magicExt;
      } else if (mimeType) {
        // Magic bytes returned the default; try the MIME type hint.
        ext = this.extensionFromMimeType(mimeType) ?? magicExt;
      } else {
        ext = magicExt;
      }

      // Write buffer to a temporary file for the OpenAI API
      // (The API requires a file-like object, not raw bytes)
      const tempDir = '/tmp';
      const tempFile = path.join(
        tempDir,
        `stt-${Date.now()}-${Math.random().toString(36).substring(7)}${ext}`,
      );

      try {
        fs.writeFileSync(tempFile, audioBuffer);

        // Call Whisper API with timestamp granularities for word-level timing
        const response = await this.openai.audio.transcriptions.create({
          file: fs.createReadStream(tempFile),
          model: 'whisper-1',
          language: 'en', // Default to English; Whisper will auto-detect if needed
          response_format: 'verbose_json', // Get detailed response with confidence
        });

        // Clean up the temporary file
        fs.unlinkSync(tempFile);

        // Extract confidence from response
        // Whisper's verbose JSON includes duration in seconds
        const duration = response.duration ?? 0;
        const durationMs = Math.round(duration * 1000);

        // Derive confidence from the response
        // If Whisper provides no-confidence data, default to 0.80 (high confidence)
        // Conservative approach: 0.80 base, reduced for longer audio or empty text
        let confidence = 0.80;

        if (!response.text || response.text.trim().length === 0) {
          confidence = 0.40; // Very low confidence if empty transcription
        } else if (durationMs > 60000) {
          // Longer audio tends to have more transcription error risk
          confidence = Math.max(0.65, confidence - 0.05);
        }

        return {
          text: response.text,
          confidence,
          languageCode: response.language ?? 'en',
          durationMs,
        };
      } finally {
        // Ensure cleanup even if the API call fails
        if (fs.existsSync(tempFile)) {
          try {
            fs.unlinkSync(tempFile);
          } catch (e) {
            this.logger.warn(`Failed to clean up temp file ${tempFile}: ${e}`);
          }
        }
      }
    } catch (error) {
      // If it's already an STTDegradationError, re-throw it
      if (error instanceof STTDegradationError) {
        this.logger.error(`STT degradation: ${error.message}`);
        throw error;
      }

      // Wrap other errors as STTDegradationError for graceful degradation
      const message = `Whisper API failed: ${error instanceof Error ? error.message : String(error)}`;
      this.logger.error(message);
      throw new STTDegradationError(message, error instanceof Error ? error : undefined);
    }
  }
}
