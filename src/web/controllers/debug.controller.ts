import { Controller, Get } from '@nestjs/common';

/**
 * DebugController — Stub endpoints for frontend debug panels.
 *
 * Provides status endpoints that the frontend polls on startup.
 * These return safe defaults so the dashboard loads without errors.
 */
@Controller('api/debug')
export class DebugController {
  @Get('camera/status')
  getCameraStatus(): { active: boolean } {
    return { active: false };
  }
}
