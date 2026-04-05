import {
  Controller,
  Get,
  Post,
  Param,
  HttpCode,
  NotFoundException,
} from '@nestjs/common';
import { SttService } from '../services/stt.service';
import { TtsService } from '../services/tts.service';

@Controller('voice')
export class VoiceController {
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
   * For real-time streaming STT, the /ws/audio gateway is preferred.
   */
  @Post('transcribe')
  @HttpCode(200)
  transcribe() {
    return { text: '', confidence: 0, latencyMs: 0 };
  }

  @Get('audio/:turnId')
  getAudio(@Param('turnId') _turnId: string) {
    throw new NotFoundException('No audio available');
  }
}
