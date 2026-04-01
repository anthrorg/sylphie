/**
 * ElevenLabsTtsService — synthesizes text to audio via the ElevenLabs API.
 *
 * Implements ITtsService. Drop-in replacement for the OpenAI TTS-based
 * TtsService. Called in the final delivery step of the Communication pipeline
 * after the response has passed TheaterValidator.
 *
 * CANON §Communication: Voice is the preferred channel, not the only channel.
 * TTS failures never block system operation (graceful degradation).
 *
 * Pre-computed acknowledgment cache is retained: common short responses are
 * synthesized once at startup to avoid repeated API calls.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  ITtsService,
  SynthesisResult,
  TtsOptions,
} from '../interfaces/communication.interfaces';
import type { AppConfig } from '../../shared/config/app.config';
import { TTSDegradationError } from './voice.errors';

interface AcknowledgmentCache {
  [text: string]: Buffer;
}

@Injectable()
export class ElevenLabsTtsService implements ITtsService {
  private readonly logger = new Logger(ElevenLabsTtsService.name);
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly baseUrl = 'https://api.elevenlabs.io/v1';
  private acknowledgmentCache: AcknowledgmentCache = {};

  private readonly acknowledgments = [
    'I see',
    'Hmm',
    'Okay',
    'Got it',
    'Sure',
    'Right',
  ];

  constructor(private readonly config: ConfigService) {
    const appConfig = this.config.get<AppConfig>('app');
    this.apiKey = appConfig?.elevenlabs?.apiKey ?? '';
    this.voiceId = appConfig?.elevenlabs?.voiceId ?? '';
    this.modelId = appConfig?.elevenlabs?.modelId ?? 'eleven_monolingual_v1';

    if (!this.apiKey) {
      this.logger.warn(
        'ELEVENLABS_API_KEY not configured. TTS will fail at runtime.',
      );
    }

    if (!this.voiceId) {
      this.logger.warn(
        'ELEVENLABS_VOICE_ID not configured. TTS will fail at runtime.',
      );
    }

    this.preComputeAcknowledgments().catch((error) => {
      this.logger.error(`Failed to pre-compute acknowledgments: ${error}`);
    });
  }

  private async preComputeAcknowledgments(): Promise<void> {
    if (!this.apiKey || !this.voiceId) {
      this.logger.warn(
        'Skipping acknowledgment pre-computation: no API key or voice ID configured',
      );
      return;
    }

    for (const text of this.acknowledgments) {
      try {
        const buffer = await this.synthesizeViaApi(text);
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

  async synthesize(
    text: string,
    options?: TtsOptions,
  ): Promise<SynthesisResult> {
    try {
      if (!this.apiKey) {
        throw new TTSDegradationError(
          'ElevenLabs API key not configured. Set ELEVENLABS_API_KEY environment variable.',
        );
      }

      if (!this.voiceId) {
        throw new TTSDegradationError(
          'ElevenLabs voice ID not configured. Set ELEVENLABS_VOICE_ID environment variable.',
        );
      }

      if (!text || text.trim().length === 0) {
        throw new TTSDegradationError('Text to synthesize is empty');
      }

      // Check pre-computed acknowledgment cache
      if (this.acknowledgmentCache[text]) {
        return {
          audioBuffer: this.acknowledgmentCache[text],
          durationMs: this.estimateDuration(text),
          format: 'mp3',
        };
      }

      const audioBuffer = await this.synthesizeViaApi(text, options);

      return {
        audioBuffer,
        durationMs: this.estimateDuration(text),
        format: options?.format ?? 'mp3',
      };
    } catch (error) {
      if (error instanceof TTSDegradationError) {
        this.logger.error(`TTS degradation: ${error.message}`);
        throw error;
      }

      const message = `ElevenLabs TTS API failed: ${error instanceof Error ? error.message : String(error)}`;
      this.logger.error(message);
      throw new TTSDegradationError(
        message,
        error instanceof Error ? error : undefined,
      );
    }
  }

  private async synthesizeViaApi(
    text: string,
    options?: TtsOptions,
  ): Promise<Buffer> {
    const voiceId = this.voiceId;

    const body = {
      text,
      model_id: this.modelId,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true,
      },
    };

    const outputFormat = options?.format ?? 'mp3';
    const params = new URLSearchParams({
      output_format: outputFormat === 'mp3' ? 'mp3_44100_128' : 'pcm_44100',
    });

    const response = await fetch(
      `${this.baseUrl}/text-to-speech/${voiceId}?${params}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      throw new TTSDegradationError(
        `ElevenLabs API error: ${response.status} ${response.statusText}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private estimateDuration(text: string): number {
    const words = text.trim().split(/\s+/).length;
    const estimatedMs = Math.round(words * 400 + 500);
    return Math.max(500, Math.min(estimatedMs, 120000));
  }
}
