/**
 * TtsService — synthesizes text to audio via the OpenAI TTS API.
 *
 * Implements ITtsService. Called in the final delivery step of the
 * Communication pipeline after the response has passed TheaterValidator.
 * The synthesized audio is sent to the hardware output layer (speaker or
 * chatbox player).
 *
 * CANON §Communication: Voice is the preferred channel, not the only channel.
 * TTS failures never block system operation (graceful degradation).
 * Audio failures throw TTSDegradationError, which callers catch and handle
 * by skipping audio output and delivering text-only response.
 *
 * Pre-computed Acknowledgments Cache:
 * Common single-word and two-word responses are pre-generated at startup to
 * avoid latency for frequent acknowledgments. This reduces Type 2 cost
 * (CognitiveAwareness pressure) for high-frequency responses.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAI } from 'openai';
import * as fs from 'fs';
import * as path from 'path';

import type {
  ITtsService,
  SynthesisResult,
  TtsOptions,
} from '../interfaces/communication.interfaces';
import type { AppConfig } from '../../shared/config/app.config';
import { TTSDegradationError } from './voice.errors';

/**
 * Pre-computed acknowledgments cache.
 * Common short responses are synthesized once at startup to avoid repeated TTS calls.
 */
interface AcknowledgmentCache {
  [text: string]: Buffer;
}

@Injectable()
export class TtsService implements ITtsService {
  private readonly logger = new Logger(TtsService.name);
  private readonly openai: OpenAI;
  private readonly apiKey: string;
  private readonly defaultVoice: string;
  private readonly defaultFormat: 'mp3' | 'opus' | 'aac' | 'flac';
  private readonly defaultSpeed: number;
  private acknowledgmentCache: AcknowledgmentCache = {};

  // Common acknowledgments to pre-compute
  private readonly acknowledgments = ['I see', 'Hmm', 'Okay', 'Got it', 'Sure', 'Right'];

  constructor(private readonly config: ConfigService) {
    const appConfig = this.config.get<AppConfig>('app');
    this.apiKey = appConfig?.openaiVoice?.apiKey ?? '';
    this.defaultVoice = appConfig?.openaiVoice?.defaultVoice ?? 'nova';
    this.defaultFormat = appConfig?.openaiVoice?.defaultFormat ?? 'mp3';
    this.defaultSpeed = appConfig?.openaiVoice?.defaultSpeed ?? 1.0;

    if (!this.apiKey) {
      this.logger.warn(
        'OPENAI_API_KEY not configured. TTS will fail at runtime. ' +
          'Set OPENAI_API_KEY environment variable.',
      );
    }

    this.openai = new OpenAI({ apiKey: this.apiKey });

    // Pre-compute acknowledgments cache on initialization
    this.preComputeAcknowledgments().catch((error) => {
      this.logger.error(`Failed to pre-compute acknowledgments: ${error}`);
    });
  }

  /**
   * Pre-compute acknowledgments cache for common short responses.
   * Runs asynchronously at startup; failures are logged but non-fatal.
   */
  private async preComputeAcknowledgments(): Promise<void> {
    if (!this.apiKey) {
      this.logger.warn('Skipping acknowledgment pre-computation: no API key configured');
      return;
    }

    for (const text of this.acknowledgments) {
      try {
        const buffer = await this.synthesizeViaApi(text, {
          voice: this.defaultVoice,
          speed: this.defaultSpeed,
          format: this.defaultFormat,
        });
        this.acknowledgmentCache[text] = buffer;
        this.logger.debug(`Pre-computed acknowledgment: "${text}"`);
      } catch (error) {
        this.logger.warn(
          `Failed to pre-compute acknowledgment "${text}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.debug(
      `Acknowledgment cache initialized with ${Object.keys(this.acknowledgmentCache).length} items`,
    );
  }

  /**
   * Synthesize text to audio using the OpenAI TTS API.
   *
   * If the text is in the pre-computed acknowledgment cache, returns the
   * cached buffer immediately. Otherwise, calls the TTS API.
   *
   * @param text - The text to synthesize
   * @param options - Optional configuration (voice, speed, format)
   * @returns Synthesis result with audio buffer, duration, and format
   * @throws TTSDegradationError if the TTS API fails
   */
  async synthesize(text: string, options?: TtsOptions): Promise<SynthesisResult> {
    try {
      if (!this.apiKey) {
        throw new TTSDegradationError(
          'OpenAI API key not configured. Set OPENAI_API_KEY environment variable.',
        );
      }

      if (!text || text.trim().length === 0) {
        throw new TTSDegradationError('Text to synthesize is empty');
      }

      // Check pre-computed acknowledgment cache
      if (this.acknowledgmentCache[text]) {
        const buffer = this.acknowledgmentCache[text];
        return {
          audioBuffer: buffer,
          durationMs: this.estimateDuration(text),
          format: this.defaultFormat,
        };
      }

      // Synthesize via API
      const audioBuffer = await this.synthesizeViaApi(text, options);

      return {
        audioBuffer,
        durationMs: this.estimateDuration(text),
        format: options?.format ?? this.defaultFormat,
      };
    } catch (error) {
      // If it's already a TTSDegradationError, re-throw it
      if (error instanceof TTSDegradationError) {
        this.logger.error(`TTS degradation: ${error.message}`);
        throw error;
      }

      // Wrap other errors as TTSDegradationError for graceful degradation
      const message = `OpenAI TTS API failed: ${error instanceof Error ? error.message : String(error)}`;
      this.logger.error(message);
      throw new TTSDegradationError(message, error instanceof Error ? error : undefined);
    }
  }

  /**
   * Internal method: synthesize via the OpenAI TTS API.
   * Does not consult the acknowledgment cache.
   */
  private async synthesizeViaApi(
    text: string,
    options?: TtsOptions,
  ): Promise<Buffer> {
    const voice = (options?.voice ?? this.defaultVoice) as
      | 'alloy'
      | 'echo'
      | 'fable'
      | 'onyx'
      | 'nova'
      | 'shimmer';
    const speed = options?.speed ?? this.defaultSpeed;
    const format = options?.format ?? this.defaultFormat;

    // Validate voice
    const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
    if (!validVoices.includes(voice)) {
      throw new TTSDegradationError(
        `Invalid voice "${voice}". Supported voices: ${validVoices.join(', ')}`,
      );
    }

    // Validate speed
    if (speed < 0.25 || speed > 4.0) {
      throw new TTSDegradationError(
        `Invalid speed ${speed}. Speed must be between 0.25 and 4.0`,
      );
    }

    // Call OpenAI TTS API
    const response = await this.openai.audio.speech.create({
      input: text,
      model: 'tts-1',
      voice,
      speed,
      response_format: format,
    });

    // Convert response to Buffer
    // response.body is a ReadableStream
    const chunks: Buffer[] = [];
    for await (const chunk of response.body as any) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  /**
   * Estimate duration in milliseconds based on text length.
   * Used for pacing and latency accounting.
   *
   * Rough estimate: average speaking rate is ~150 words per minute,
   * or about 0.4 seconds per word. We also add a base for API latency.
   */
  private estimateDuration(text: string): number {
    // Count words (split on whitespace)
    const words = text.trim().split(/\s+/).length;
    // Estimate: 400ms per word + 500ms base (API + synthesis overhead)
    const estimatedMs = Math.round(words * 400 + 500);
    return Math.max(500, Math.min(estimatedMs, 120000)); // Cap at 2 minutes
  }
}
