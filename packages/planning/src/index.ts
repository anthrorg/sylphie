/**
 * @sylphie/planning -- Public API barrel export.
 *
 * Only three things are exported:
 *   1. PlanningModule -- the NestJS module to import in AppModule.
 *   2. PLANNING_SERVICE -- the DI token to inject IPlanningService.
 *   3. IPlanningService -- the interface (type-only) for type-safe injection.
 *
 * All pipeline step tokens, concrete service classes, and internal interfaces
 * are intentionally NOT exported. They are implementation details of the
 * Planning subsystem and must not be imported by other modules.
 */

export { PlanningModule } from './planning.module';
export { PLANNING_SERVICE } from './planning.tokens';
export type {
  IPlanningService,
  PlanningCycleResult,
  PlanOutcomeData,
} from './interfaces/planning.interfaces';
