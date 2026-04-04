import {
  Controller,
  Get,
  Post,
  Param,
  HttpCode,
  NotFoundException,
} from '@nestjs/common';

@Controller('voice')
export class VoiceController {
  @Get('status')
  getStatus() {
    return { available: false };
  }

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
