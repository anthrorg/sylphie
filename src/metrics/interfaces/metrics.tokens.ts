/**
 * Dependency injection tokens for the Metrics module.
 *
 * Symbol tokens prevent name collisions at DI registration. The Metrics module
 * provides three main services for health computation, drift detection, and
 * attractor monitoring.
 *
 * Usage:
 *   import { METRICS_COMPUTATION, DRIFT_DETECTION, ATTRACTOR_DETECTION } from '../metrics/interfaces/metrics.tokens';
 *   @Inject(METRICS_COMPUTATION) private readonly metrics: IMetricsComputation
 *   @Inject(DRIFT_DETECTION) private readonly driftDetector: IDriftDetection
 *   @Inject(ATTRACTOR_DETECTION) private readonly attractorDetector: IAttractorDetection
 */

/** DI token for the metrics computation service. */
export const METRICS_COMPUTATION = Symbol('METRICS_COMPUTATION');

/** DI token for the drift detection service. */
export const DRIFT_DETECTION = Symbol('DRIFT_DETECTION');

/** DI token for the attractor detection service. */
export const ATTRACTOR_DETECTION = Symbol('ATTRACTOR_DETECTION');
