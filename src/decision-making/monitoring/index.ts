/**
 * Barrel export for decision-making monitoring subsystem.
 *
 * INTERNAL ONLY: These exports are used within DecisionMakingModule only.
 * They are not re-exported from the decision-making/index.ts barrel (public API).
 *
 * EXPORTED:
 *   AttractorMonitorService       — Service that detects attractor states
 *   AttractorAlert                — Type for alert notifications
 *   AttractorMetrics              — Type for risk metrics snapshot
 *   ATTRACTOR_MONITOR_SERVICE     — Injection token
 */

export { AttractorMonitorService, AttractorAlert, AttractorMetrics } from './attractor-monitor.service';
