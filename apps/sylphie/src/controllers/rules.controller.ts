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
} from '@nestjs/common';
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
    await this.rulesService.approveRule(id);
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
    await this.rulesService.rejectRule(id);
    return { success: true };
  }
}
