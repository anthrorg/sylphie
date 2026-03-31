/**
 * MetricsModule — DI wiring for health metrics, drift detection, and attractor monitoring.
 *
 * Available in both dev/test and production. Provides three main services:
 * - METRICS_COMPUTATION: Calculates the seven primary health metrics from event logs
 * - DRIFT_DETECTION: Detects metric anomalies against historical baselines
 * - ATTRACTOR_DETECTION: Assesses proximity to the six known failure modes
 *
 * Imports EventsModule (for event queries) and KnowledgeModule (for entity/graph metrics).
 * Also imports DriveEngineModule to access drive state for integration scoring.
 *
 * CANON §Module boundary: Consumers import from the barrel (index.ts) and
 * inject by token, never by concrete class.
 *
 * CANON §Development Metrics: These three services measure system health and
 * guard against silent drift into attractors.
 */

import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { DriveEngineModule } from '../drive-engine/drive-engine.module';
import {
  METRICS_COMPUTATION,
  DRIFT_DETECTION,
  ATTRACTOR_DETECTION,
} from './interfaces/metrics.tokens';
import { MetricsComputationService } from './metrics-computation.service';
import { DriftDetectionService } from './drift-detection.service';
import { AttractorDetectionService } from './attractor-detection.service';

@Module({
  imports: [EventsModule, KnowledgeModule, DriveEngineModule],
  providers: [
    {
      provide: METRICS_COMPUTATION,
      useClass: MetricsComputationService,
    },
    {
      provide: DRIFT_DETECTION,
      useClass: DriftDetectionService,
    },
    {
      provide: ATTRACTOR_DETECTION,
      useClass: AttractorDetectionService,
    },
  ],
  exports: [METRICS_COMPUTATION, DRIFT_DETECTION, ATTRACTOR_DETECTION],
})
export class MetricsModule {}
