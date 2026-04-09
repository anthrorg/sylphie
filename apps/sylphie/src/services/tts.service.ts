import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verboseFor } from '@sylphie/shared';

const vlog = verboseFor('Voice');

/**
 * Text-to-Speech via ElevenLabs REST streaming API.
 *
 * Accepts text, returns an MP3 audio buffer that the gateway can
 * base64-encode and send to the client for playback.
 */
@Injectable()
export class TtsService implements OnModuleInit {
  private readonly logger = new Logger(TtsService.name);
  private apiKey = '';
  private voiceId = '';
  private modelId = '';

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.apiKey = this.config.get<string>('voice.elevenlabsApiKey') ?? '';
    this.voiceId =
      this.config.get<string>('voice.elevenlabsVoiceId') ??
      '21m00Tcm4TlvDq8ikWAM';
    this.modelId =
      this.config.get<string>('voice.elevenlabsModelId') ??
      'eleven_turbo_v2_5';

    this.logger.log(
      `TTS init: key=${this.apiKey ? `set (${this.apiKey.length} chars)` : 'MISSING'}, ` +
      `voice=${this.voiceId}, model=${this.modelId}`,
    );
  }

  get available(): boolean {
    return !!this.apiKey;
  }

  /**
   * Synthesise speech for the given text.
   * Returns a Buffer of MP3 audio, or null if TTS is unavailable or fails.
   */
  async synthesize(text: string): Promise<Buffer | null> {
    if (!this.available) {
      vlog('TTS unavailable — no API key', {});
      return null;
    }

    const trimmed = text.trim();
    if (!trimmed) return null;

    vlog('TTS synthesis request', { textLength: trimmed.length, textPreview: trimmed.substring(0, 50) });

    const t0 = Date.now();
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify({
            text: trimmed,
            model_id: this.modelId,
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
            },
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.logger.error(
          `ElevenLabs API error ${response.status}: ${body.slice(0, 200)}`,
        );
        vlog('TTS API error', { status: response.status, body: body.slice(0, 200) });
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const latencyMs = Date.now() - t0;
      vlog('TTS synthesis complete', { latencyMs, audioBytes: buffer.length });
      return buffer;
    } catch (err) {
      this.logger.error(
        `TTS synthesis failed: ${(err as Error).message}`,
      );
      vlog('TTS synthesis error', { error: (err as Error).message });
      return null;
    }
  }
}
