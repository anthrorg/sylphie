/**
 * MetricsComputationService — Computes seven primary health metrics from event logs.
 *
 * Reads events from TimescaleDB and synthesizes them into first-class metric types:
 * 1. Type 1 / Type 2 ratio
 * 2. Prediction MAE (mean absolute error)
 * 3. Experiential provenance ratio
 * 4. Behavioral diversity index
 * 5. Guardian response rate
 * 6. Interoceptive accuracy
 * 7. Mean drive resolution time
 *
 * All metrics are computed from actual event logs via injected services.
 * Results are cached with configurable TTL.
 *
 * CANON §Development Metrics: These seven metrics measure system autonomy.
 */

import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IMetricsComputation, DriftMetrics } from './interfaces/metrics.interfaces';
import type {
  HealthMetrics,
  Type1Type2Ratio,
  PredictionMAEMetric,
  ProvenanceRatio,
  BehavioralDiversityIndex,
  GuardianResponseRate,
  InteroceptiveAccuracy,
  MeanDriveResolutionTime,
} from '../shared/types/metrics.types';
import type { IEventService } from '../events/interfaces/events.interfaces';
import type { IWkgService } from '../knowledge/interfaces/knowledge.interfaces';
import type { IDriveStateReader } from '../drive-engine/interfaces/drive-engine.interfaces';
import type { ISelfKgService } from '../knowledge/interfaces/knowledge.interfaces';
import { EVENTS_SERVICE } from '../events/events.tokens';
import { WKG_SERVICE, SELF_KG_SERVICE } from '../knowledge/knowledge.tokens';
import { DRIVE_STATE_READER } from '../drive-engine/drive-engine.tokens';
import { DriveName } from '../shared/types/drive.types';

/**
 * Simple in-memory cache for metric results with TTL.
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

@Injectable()
export class MetricsComputationService implements IMetricsComputation {
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly cacheTTL: number; // milliseconds
  private readonly type1Type2Window: number; // milliseconds
  private readonly predictionMAEWindow: number; // sample count
  private readonly actionDiversityWindow: number; // action count (default 20)
  private readonly driveResolutionWindow: number; // milliseconds

  constructor(
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
    @Inject(WKG_SERVICE) private readonly wkgService: IWkgService,
    @Inject(DRIVE_STATE_READER) private readonly driveReader: IDriveStateReader,
    @Inject(SELF_KG_SERVICE) private readonly selfKgService: ISelfKgService,
    private readonly config: ConfigService,
  ) {
    // Default cache TTL: 5 minutes
    this.cacheTTL = this.config.get<number>('METRICS_CACHE_TTL_MS') ?? 5 * 60 * 1000;

    // Default time windows
    // Type 1/2 ratio: last 1 hour
    this.type1Type2Window = this.config.get<number>('METRICS_TYPE1_WINDOW_MS') ?? 60 * 60 * 1000;

    // Prediction MAE: last 20 predictions
    this.predictionMAEWindow = this.config.get<number>('METRICS_PREDICTION_WINDOW') ?? 20;

    // Action diversity: 20-action window (per CANON)
    this.actionDiversityWindow = this.config.get<number>('METRICS_ACTION_WINDOW') ?? 20;

    // Drive resolution: last 6 hours
    this.driveResolutionWindow = this.config.get<number>('METRICS_DRIVE_WINDOW_MS') ?? 6 * 60 * 60 * 1000;
  }

  /**
   * Compute all seven primary health metrics for a given session.
   *
   * Reads all relevant events from TimescaleDB for the session, aggregates them,
   * and returns a complete HealthMetrics snapshot. This is a heavy operation and
   * should typically be called once per session (or once per 10 sessions for
   * baseline snapshots).
   *
   * @param sessionId - The session to compute metrics for
   * @returns HealthMetrics with all seven primary metrics
   */
  async computeHealthMetrics(sessionId: string): Promise<HealthMetrics> {
    const cacheKey = `health-metrics-${sessionId}`;
    const cached = this.getFromCache<HealthMetrics>(cacheKey);
    if (cached) return cached;

    const now = new Date();

    // Compute all seven metrics in parallel where possible
    const [
      type1Type2Ratio,
      predictionMAE,
      provenanceRatio,
      behavioralDiversityIndex,
      guardianResponseRate,
      interoceptiveAccuracy,
      meanDriveResolutionTimes,
    ] = await Promise.all([
      this.computeType1Type2Ratio(sessionId),
      this.computePredictionMAE(sessionId),
      this.computeProvenanceRatio(),
      this.computeBehavioralDiversityIndex(sessionId),
      this.computeGuardianResponseRate(sessionId),
      this.computeInteroceptiveAccuracy(),
      this.computeMeanDriveResolutionTimes(sessionId),
    ]);

    const result: HealthMetrics = {
      computedAt: now,
      sessionId,
      type1Type2Ratio,
      predictionMAE,
      provenanceRatio,
      behavioralDiversityIndex,
      guardianResponseRate,
      interoceptiveAccuracy,
      meanDriveResolutionTimes,
    };

    this.setInCache(cacheKey, result);
    return result;
  }

  /**
   * Compute drift metrics for the most recent session window.
   *
   * Compares current health metrics against a baseline captured ~sessionWindow
   * sessions ago. Returns the drift summary with anomalies and trend scores.
   *
   * @param sessionWindow - Number of sessions to compare (typically 10)
   * @returns DriftMetrics with anomalies and trend analysis
   */
  async computeDriftMetrics(sessionWindow: number): Promise<DriftMetrics> {
    const cacheKey = `drift-metrics-${sessionWindow}`;
    const cached = this.getFromCache<DriftMetrics>(cacheKey);
    if (cached) return cached;

    // For a complete implementation, this would:
    // 1. Query all sessions in the window
    // 2. Compute health metrics for each
    // 3. Detect behavioral diversity trend
    // 4. Detect prediction accuracy trend
    // 5. Detect guardian interaction quality trend
    // 6. Analyze sustained drive patterns
    // 7. Detect anomalies against baseline

    // Stub: Return a minimal valid DriftMetrics
    const result: DriftMetrics = {
      cumulativeRecordSlope: 1.0,
      behavioralDiversityTrend: 0.0,
      predictionAccuracyTrend: 0.0,
      guardianInteractionQuality: 0.0,
      sustainedDrivePatterns: [],
      anomalies: [],
      computedAt: new Date(),
      sessionWindow,
    };

    this.setInCache(cacheKey, result);
    return result;
  }

  // ========================================================================
  // Private: Metric computation methods
  // ========================================================================

  private async computeType1Type2Ratio(sessionId: string): Promise<Type1Type2Ratio> {
    const now = new Date();
    const startTime = new Date(now.getTime() - this.type1Type2Window);

    const [type1Events, type2Events] = await Promise.all([
      this.eventsService.query({
        types: ['TYPE_1_SELECTED'],
        sessionId,
        startTime,
        endTime: now,
      }),
      this.eventsService.query({
        types: ['TYPE_2_SELECTED'],
        sessionId,
        startTime,
        endTime: now,
      }),
    ]);

    const type1Count = type1Events.length;
    const type2Count = type2Events.length;
    const windowSize = type1Count + type2Count;
    const ratio = windowSize > 0 ? type1Count / windowSize : NaN;

    return {
      type1Count,
      type2Count,
      ratio,
      windowSize,
      computedAt: now,
    };
  }

  private async computePredictionMAE(sessionId: string): Promise<PredictionMAEMetric> {
    const now = new Date();

    const events = await this.eventsService.query({
      types: ['PREDICTION_EVALUATED'],
      sessionId,
      limit: this.predictionMAEWindow,
    });

    const errors = events
      .map(e => {
        if (e.type === 'PREDICTION_EVALUATED' && 'absoluteError' in e) {
          return (e as any).absoluteError as number;
        }
        return null;
      })
      .filter((err): err is number => err !== null);

    const sampleCount = errors.length;
    const mae = sampleCount > 0 ? errors.reduce((a, b) => a + b, 0) / sampleCount : NaN;

    return {
      mae,
      sampleCount,
      windowSize: this.predictionMAEWindow,
      computedAt: now,
    };
  }

  private async computeProvenanceRatio(): Promise<ProvenanceRatio> {
    const now = new Date();
    const stats = await this.wkgService.queryGraphStats();

    const sensor = stats.byProvenance['SENSOR'] ?? 0;
    const guardian = stats.byProvenance['GUARDIAN'] ?? 0;
    const llmGenerated = stats.byProvenance['LLM_GENERATED'] ?? 0;
    const inference = stats.byProvenance['INFERENCE'] ?? 0;

    const experientialCount = sensor + guardian + inference;
    const total = stats.totalNodes;
    const experientialRatio = total > 0 ? experientialCount / total : NaN;

    return {
      sensor,
      guardian,
      llmGenerated,
      inference,
      total,
      experientialRatio,
      computedAt: now,
    };
  }

  private async computeBehavioralDiversityIndex(sessionId: string): Promise<BehavioralDiversityIndex> {
    const now = new Date();

    // Query recent ACTION_EXECUTED events
    const events = await this.eventsService.query({
      types: ['ACTION_EXECUTED'],
      sessionId,
      limit: this.actionDiversityWindow,
    });

    // Extract unique actionType values
    const actionTypes = new Set<string>();
    for (const event of events) {
      if (event.type === 'ACTION_EXECUTED' && 'actionType' in event) {
        actionTypes.add((event as any).actionType as string);
      }
    }

    const uniqueActionTypes = actionTypes.size;
    const windowSize = events.length;
    const index = windowSize > 0 ? uniqueActionTypes / windowSize : NaN;

    return {
      uniqueActionTypes,
      windowSize,
      index,
      computedAt: now,
    };
  }

  private async computeGuardianResponseRate(sessionId: string): Promise<GuardianResponseRate> {
    const now = new Date();

    // Query SOCIAL_COMMENT_INITIATED events
    const initiatedEvents = await this.eventsService.query({
      types: ['SOCIAL_COMMENT_INITIATED'],
      sessionId,
    });

    const initiated = initiatedEvents.length;

    // Query SOCIAL_CONTINGENCY_MET events (guardian responses)
    const respondedEvents = await this.eventsService.query({
      types: ['SOCIAL_CONTINGENCY_MET'],
      sessionId,
    });

    const responded = respondedEvents.length;
    const rate = initiated > 0 ? responded / initiated : NaN;

    return {
      initiated,
      responded,
      rate,
      computedAt: now,
    };
  }

  private async computeInteroceptiveAccuracy(): Promise<InteroceptiveAccuracy> {
    const now = new Date();

    // Get current drive state from Drive Engine
    const driveSnapshot = this.driveReader.getCurrentState();
    const actual = driveSnapshot.totalPressure / 12; // Normalize to [0, 1]

    // Get self-model assessment from Self KG
    const selfModel = await this.selfKgService.getCurrentModel();
    const selfReported = selfModel.primaryConceptConfidence; // Simplified; could be more sophisticated

    const accuracy = 1.0 - Math.abs(selfReported - actual);

    return {
      selfReported,
      actual,
      accuracy,
      computedAt: now,
    };
  }

  private async computeMeanDriveResolutionTimes(
    sessionId: string,
  ): Promise<Readonly<Partial<Record<string, MeanDriveResolutionTime>>>> {
    const now = new Date();
    const startTime = new Date(now.getTime() - this.driveResolutionWindow);

    // Query DRIVE_TICK events to find pressure onset and resolution transitions
    const driveTickEvents = await this.eventsService.query({
      types: ['DRIVE_TICK'],
      sessionId,
      startTime,
      endTime: now,
    });

    // Group by drive and track pressure patterns
    const driveResolutions: Record<string, number[]> = {};

    // Get pressure values from consecutive snapshots
    for (let i = 0; i < driveTickEvents.length - 1; i++) {
      const current = driveTickEvents[i];
      const next = driveTickEvents[i + 1];

      const currentSnapshot = current.driveSnapshot;
      const nextSnapshot = next.driveSnapshot;

      // Access drive pressures safely using the DriveName enum values
      this.checkDriveTransition(
        DriveName.SystemHealth,
        currentSnapshot,
        nextSnapshot,
        current.timestamp,
        next.timestamp,
        driveResolutions,
      );
      this.checkDriveTransition(
        DriveName.MoralValence,
        currentSnapshot,
        nextSnapshot,
        current.timestamp,
        next.timestamp,
        driveResolutions,
      );
      this.checkDriveTransition(
        DriveName.Integrity,
        currentSnapshot,
        nextSnapshot,
        current.timestamp,
        next.timestamp,
        driveResolutions,
      );
      this.checkDriveTransition(
        DriveName.CognitiveAwareness,
        currentSnapshot,
        nextSnapshot,
        current.timestamp,
        next.timestamp,
        driveResolutions,
      );
      this.checkDriveTransition(
        DriveName.Guilt,
        currentSnapshot,
        nextSnapshot,
        current.timestamp,
        next.timestamp,
        driveResolutions,
      );
      this.checkDriveTransition(
        DriveName.Curiosity,
        currentSnapshot,
        nextSnapshot,
        current.timestamp,
        next.timestamp,
        driveResolutions,
      );
      this.checkDriveTransition(
        DriveName.Boredom,
        currentSnapshot,
        nextSnapshot,
        current.timestamp,
        next.timestamp,
        driveResolutions,
      );
      this.checkDriveTransition(
        DriveName.Anxiety,
        currentSnapshot,
        nextSnapshot,
        current.timestamp,
        next.timestamp,
        driveResolutions,
      );
      this.checkDriveTransition(
        DriveName.Satisfaction,
        currentSnapshot,
        nextSnapshot,
        current.timestamp,
        next.timestamp,
        driveResolutions,
      );
      this.checkDriveTransition(
        DriveName.Sadness,
        currentSnapshot,
        nextSnapshot,
        current.timestamp,
        next.timestamp,
        driveResolutions,
      );
      this.checkDriveTransition(
        DriveName.InformationIntegrity,
        currentSnapshot,
        nextSnapshot,
        current.timestamp,
        next.timestamp,
        driveResolutions,
      );
      this.checkDriveTransition(
        DriveName.Social,
        currentSnapshot,
        nextSnapshot,
        current.timestamp,
        next.timestamp,
        driveResolutions,
      );
    }

    // Compute means for drives with sufficient samples
    const result: Record<string, MeanDriveResolutionTime> = {};
    for (const [driveName, durations] of Object.entries(driveResolutions)) {
      if (durations.length >= 5) {
        const meanMs = durations.reduce((a, b) => a + b, 0) / durations.length;
        result[driveName] = {
          drive: driveName,
          meanMs,
          sampleCount: durations.length,
          computedAt: now,
        };
      }
    }

    return result;
  }

  /**
   * Helper to check if a drive transitions from pressure to relief.
   */
  private checkDriveTransition(
    driveName: string,
    currentSnapshot: any,
    nextSnapshot: any,
    currentTime: Date,
    nextTime: Date,
    driveResolutions: Record<string, number[]>,
  ): void {
    const currentPressure = currentSnapshot.pressureVector[driveName] ?? 0;
    const nextPressure = nextSnapshot.pressureVector[driveName] ?? 0;

    // Detect transition: pressure elevated (>0.5) -> resolved (<0.3)
    if (currentPressure > 0.5 && nextPressure < 0.3) {
      const duration = nextTime.getTime() - currentTime.getTime();
      if (!driveResolutions[driveName]) {
        driveResolutions[driveName] = [];
      }
      driveResolutions[driveName].push(duration);
    }
  }

  // ========================================================================
  // Private: Cache helpers
  // ========================================================================

  private getFromCache<T>(key: string): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  private setInCache<T>(key: string, value: T): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTTL,
    });
  }
}
