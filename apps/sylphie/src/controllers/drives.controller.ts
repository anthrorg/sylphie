import { Controller, Post, Body } from '@nestjs/common';

@Controller('drives')
export class DrivesController {
  @Post('override')
  setOverride(@Body() _body: { drive: string; value: number; active: boolean }) {
    return {};
  }

  @Post('drift')
  setDrift(@Body() _body: { drive: string; rate: number }) {
    return {};
  }

  @Post('reset')
  resetOverrides() {
    return {};
  }
}
