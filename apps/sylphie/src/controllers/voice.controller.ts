import {
  Controller,
  Get,
  Post,
  Param,
  Req,
  HttpCode,
  NotFoundException,
  InternalServerErrorException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { SttService } from '../services/stt.service';
import { TtsService } from '../services/tts.service';

/** Minimal express request shape needed for raw audio body access. */
interface AudioRequest {
  body: Buffer | undefined;
  headers: Record<string, string | string[] | undefined>;
}

@Controller('voice')
export class VoiceController {
  private readonly logger = new Logger(VoiceController.name);

  constructor(
    private readonly stt: SttService,
    private readonly tts: TtsService,
  ) {}

  @Get('status')
  getStatus() {
    return {
      available: this.stt.available || this.tts.available,
      stt: this.stt.available,
      tts: this.tts.available,
    };
  }

  /**
   * One-shot transcription endpoint (legacy path used by useVoiceRecording).
   * Accepts raw audio bytes in the request body; Content-Type must be the
   * actual audio MIME type (e.g. audio/webm;codecs=opus).
   *
   * Returns { text, confidence, latencyMs } on success.
   * Returns an honest HTTP error on failure — never a fake empty-200.
   * For real-time streaming STT, the /ws/audio gateway is preferred.
   */
  @Post('transcribe')
  @HttpCode(200)
  async transcribe(@Req() req: AudioRequest) {
    const audio = req.body as Buffer | undefined;
    const contentType = Array.isArray(req.headers['content-type'])
      ? req.headers['content-type'][0]
      : (req.headers['content-type'] ?? 'audio/webm');
    // Strip codec params (e.g. "audio/webm;codecs=opus" → "audio/webm") for the
    // Deepgram REST Content-Type header — codec details are WebM container metadata.
    const mimeType = contentType.split(';')[0].trim();

    if (!audio || !Buffer.isBuffer(audio) || audio.length === 0) {
      throw new InternalServerErrorException('No audio data received');
    }

    if (!this.stt.available) {
      throw new ServiceUnavailableException('STT unavailable — DEEPGRAM_API_KEY not configured');
    }

    try {
      const result = await this.stt.transcribeBuffer(audio, mimeType);
      this.logger.log(
        `Transcribed ${audio.length}B of ${mimeType}: "${result.text.slice(0, 80)}" (conf=${result.confidence.toFixed(2)}, ${result.latencyMs}ms)`,
      );
      return result;
    } catch (err) {
      this.logger.error(`Transcription failed: ${(err as Error).message}`);
      throw new InternalServerErrorException('Transcription failed');
    }
  }

  @Get('audio/:turnId')
  getAudio(@Param('turnId') _turnId: string) {
    throw new NotFoundException('No audio available');
  }
}
