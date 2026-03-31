/**
 * DevelopmentGuard — Route guard for development-only endpoints.
 *
 * Restricts access to certain endpoints (debugging, introspection, admin tools)
 * to development mode only. In production, these endpoints are not accessible
 * regardless of user credentials.
 *
 * Usage:
 *   @Controller('api/admin')
 *   @UseGuards(DevelopmentGuard)
 *   export class AdminController { ... }
 */

import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WebConfig } from '../interfaces/web.interfaces';

@Injectable()
export class DevelopmentGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Check if the request is allowed to proceed.
   *
   * Returns true if development mode is enabled, false otherwise.
   * If development mode is disabled, throws ForbiddenException.
   *
   * @param _context - Execution context (unused in this guard)
   * @returns true if development mode is enabled
   * @throws ForbiddenException if development mode is disabled
   */
  canActivate(_context: ExecutionContext): boolean {
    const webConfig = this.configService.get<WebConfig>('web');
    const isDevelopment = webConfig?.developmentMode ?? true;

    if (!isDevelopment) {
      throw new ForbiddenException(
        'This endpoint is only available in development mode',
      );
    }

    return true;
  }
}
