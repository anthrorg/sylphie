/**
 * Metrics module barrel export.
 *
 * Consumers import from this barrel and inject by token, never by concrete class.
 * The metrics module is available in both dev/test and production.
 */

export { MetricsModule } from './metrics.module';
export {
  METRICS_COMPUTATION,
  DRIFT_DETECTION,
  ATTRACTOR_DETECTION,
} from './interfaces/metrics.tokens';
export type {
  IMetricsComputation,
  IDriftDetection,
  IAttractorDetection,
  DriftMetrics,
  DriftAnomaly,
  DriftSeverity,
  AttractorProximity,
  AttractorReport,
  DevelopmentBaseline,
} from './interfaces/metrics.interfaces';
