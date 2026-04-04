import { Controller, Get, NotFoundException } from '@nestjs/common';

@Controller('debug')
export class DebugController {
  @Get('camera/status')
  cameraStatus() {
    return { active: false };
  }

  @Get('camera/stream')
  cameraStream() {
    throw new NotFoundException('Camera not available');
  }
}
