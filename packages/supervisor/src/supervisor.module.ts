/**
 * SupervisorModule — NestJS module for the DeepSeek reasoning supervisor.
 *
 * Observes the cognitive pipeline via DecisionMakingService.response$ and
 * provides corrective training signals during bootstrap and ongoing operation.
 *
 * PUBLIC API (exported from index.ts):
 *   SUPERVISOR_SERVICE — ISupervisorService, the sole external facade.
 *
 * Dependencies:
 *   - DecisionMakingModule: provides DECISION_MAKING_SERVICE (response$ Observable)
 *     and LLM_SERVICE (OllamaLlmService for DeepSeek API calls).
 *   - DriveEngineModule: consumed transitively via DecisionMakingModule.
 */

import { Module } from '@nestjs/common';
import { DecisionMakingModule } from '@sylphie/decision-making';
import { TimescaleModule } from '@sylphie/shared';

import { SUPERVISOR_SERVICE, NARRATION_BUILDER_SERVICE, COST_TRACKER_SERVICE } from './supervisor.tokens';
import { SupervisorService } from './supervisor.service';
import { NarrationBuilderService } from './narration-builder.service';
import { CostTrackerService } from './cost-tracker.service';
import { SidecarControlService } from './sidecar-control.service';
import { VerdictAuditService } from './verdict-audit.service';
import { InterventionTrackerService } from './intervention-tracker.service';
import { AdaptiveSamplerService } from './adaptive-sampler.service';

@Module({
  imports: [
    // Provides DECISION_MAKING_SERVICE (response$) and LLM_SERVICE (DeepSeek routing)
    DecisionMakingModule,
    // TimescaleModule is @Global() but explicit import ensures DI resolution for
    // services that inject it via @Optional() — VerdictAuditService and
    // InterventionTrackerService silently drop to null (no audit rows) without it.
    TimescaleModule,
  ],
  providers: [
    // ── Public facade ────────────────────────────────────────────────────────
    {
      provide: SUPERVISOR_SERVICE,
      useClass: SupervisorService,
    },

    // ── Internal services ────────────────────────────────────────────────────
    {
      provide: NARRATION_BUILDER_SERVICE,
      useClass: NarrationBuilderService,
    },
    // Also provide as class for direct constructor injection within the module
    NarrationBuilderService,

    {
      provide: COST_TRACKER_SERVICE,
      useClass: CostTrackerService,
    },
    CostTrackerService,

    SidecarControlService,

    // ── Audit / adaptive-sampling / lifecycle services ──────────────────────
    VerdictAuditService,
    InterventionTrackerService,
    AdaptiveSamplerService,
  ],
  exports: [
    // SUPERVISOR_SERVICE is the only token exported from this module.
    SUPERVISOR_SERVICE,
  ],
})
export class SupervisorModule {}
