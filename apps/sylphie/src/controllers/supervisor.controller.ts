import { Controller, Get, Post, Body, Inject, Query } from '@nestjs/common';
import { SUPERVISOR_SERVICE } from '@sylphie/supervisor';
import type {
  ISupervisorService,
  SamplingPolicy,
  SupervisorIntervention,
} from '@sylphie/supervisor';

/**
 * REST controller for the Supervisor player view.
 *
 * Provides read access to supervisor status and verdicts, plus write access
 * to sampling policy, manual interventions, and enable/disable toggle.
 * Guardian asymmetry (CANON): these endpoints are the guardian's control surface.
 */
@Controller('supervisor')
export class SupervisorController {
  constructor(
    @Inject(SUPERVISOR_SERVICE)
    private readonly supervisorService: ISupervisorService,
  ) {}

  /**
   * Returns the full supervisor status including sampling policy, budget,
   * verdict counts, and the 20 most recent verdicts.
   */
  @Get('status')
  getStatus() {
    return this.supervisorService.getStatus();
  }

  /**
   * Returns recent verdicts from the current status buffer.
   * @param limit Maximum number of verdicts to return (default 50).
   */
  @Get('verdicts')
  getVerdicts(@Query('limit') limit = '50') {
    const status = this.supervisorService.getStatus();
    const n = Math.max(1, Math.min(parseInt(limit, 10) || 50, status.recentVerdicts.length));
    return status.recentVerdicts.slice(-n);
  }

  /**
   * Update the supervisor sampling policy at runtime.
   * Accepts a partial SamplingPolicy — only supplied fields are merged.
   */
  @Post('policy')
  updatePolicy(@Body() body: Partial<SamplingPolicy>) {
    this.supervisorService.updatePolicy(body);
    return { ok: true };
  }

  /**
   * Submit a manual intervention from the guardian (player view).
   * Source should be 'guardian' in the intervention body.
   */
  @Post('intervene')
  submitIntervention(@Body() body: SupervisorIntervention) {
    this.supervisorService.submitIntervention(body);
    return { ok: true };
  }

  /** Enable the supervisor. */
  @Post('enable')
  enable() {
    this.supervisorService.setEnabled(true);
    return { ok: true, enabled: true };
  }

  /** Disable the supervisor. */
  @Post('disable')
  disable() {
    this.supervisorService.setEnabled(false);
    return { ok: true, enabled: false };
  }
}
