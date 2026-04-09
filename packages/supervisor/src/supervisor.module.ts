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

import { SUPERVISOR_SERVICE, NARRATION_BUILDER_SERVICE, COST_TRACKER_SERVICE } from './supervisor.tokens';
import { SupervisorService } from './supervisor.service';
import { NarrationBuilderService } from './narration-builder.service';
import { CostTrackerService } from './cost-tracker.service';
import { SidecarControlService } from './sidecar-control.service';

@Module({
  imports: [
    // Provides DECISION_MAKING_SERVICE (response$) and LLM_SERVICE (DeepSeek routing)
    DecisionMakingModule,
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
  ],
  exports: [
    // SUPERVISOR_SERVICE is the only token exported from this module.
    SUPERVISOR_SERVICE,
  ],
})
export class SupervisorModule {}
