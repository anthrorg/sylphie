/**
 * RulesController — Guardian dashboard endpoints for drive rule management.
 *
 * All endpoints require authentication. Approve/reject operations additionally
 * require the guardian role (isGuardian flag in JWT).
 *
 * CANON Immutable Standard 6 (No Self-Modification of Evaluation):
 * These endpoints are the only path for modifying the active drive rule set.
 * Only guardian-authenticated users can reach the approve/reject paths.
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  Req,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GuardianCredentialsNotConfiguredError } from '@sylphie/shared';
import { AuthGuard, JwtPayload } from '../guards/auth.guard';
import { GuardianRulesService } from '../services/guardian-rules.service';

@Controller('rules')
@UseGuards(AuthGuard)
export class RulesController {
  constructor(private readonly rulesService: GuardianRulesService) {}

  @Get('proposed')
  async getProposedRules(@Query('status') status?: string) {
    return this.rulesService.getProposedRules(status);
  }

  @Get('active')
  async getActiveRules() {
    return this.rulesService.getActiveRules();
  }

  @Post(':id/approve')
  async approveRule(
    @Param('id') id: string,
    @Req() req: { user: JwtPayload },
  ) {
    if (!req.user.isGuardian) {
      throw new ForbiddenException('Only guardians can approve rules');
    }
    try {
      await this.rulesService.approveRule(id);
    } catch (error) {
      throw this.mapGuardianError(error);
    }
    return { success: true };
  }

  @Post(':id/reject')
  async rejectRule(
    @Param('id') id: string,
    @Req() req: { user: JwtPayload },
  ) {
    if (!req.user.isGuardian) {
      throw new ForbiddenException('Only guardians can reject rules');
    }
    try {
      await this.rulesService.rejectRule(id);
    } catch (error) {
      throw this.mapGuardianError(error);
    }
    return { success: true };
  }

  /**
   * Translate {@link GuardianCredentialsNotConfiguredError} into a 503 so the
   * dashboard can distinguish "guardian write path disabled" from a generic
   * server error. All other errors pass through unchanged (NestJS's default
   * exception handling still applies to them, e.g. NotFoundException -> 404).
   */
  private mapGuardianError(error: unknown): unknown {
    if (error instanceof GuardianCredentialsNotConfiguredError) {
      return new ServiceUnavailableException(error.message);
    }
    return error;
  }
}
