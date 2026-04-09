/**
 * @sylphie/supervisor — Public API barrel export.
 *
 * Only three things are exported:
 *   1. SupervisorModule — the NestJS module to import in AppModule.
 *   2. SUPERVISOR_SERVICE — the DI token to inject ISupervisorService.
 *   3. ISupervisorService — the interface (type-only) for type-safe injection.
 *
 * All internal services (NarrationBuilder, CostTracker) are implementation
 * details and intentionally NOT exported.
 */

export { SupervisorModule } from './supervisor.module';
export { SUPERVISOR_SERVICE } from './supervisor.tokens';
export type { ISupervisorService } from './supervisor.service';
export { SidecarControlService } from './sidecar-control.service';
export type { SidecarModelState } from './sidecar-control.service';
export type {
  DecisionNarration,
  SupervisorVerdict,
  SupervisorIntervention,
  SamplingPolicy,
  SupervisorStatus,
  VerdictRating,
} from './interfaces/supervisor.types';
