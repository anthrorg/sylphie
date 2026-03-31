/**
 * Barrel export for the threshold computation subsystem.
 *
 * Exports the service class and interface contracts for internal Decision
 * Making module wiring only. Not exported from the decision-making module
 * barrel (index.ts) — threshold computation is an internal detail.
 */

export { ThresholdComputationService } from './threshold-computation.service';
export { IThresholdComputationService, ThresholdResult } from './threshold.interfaces';
