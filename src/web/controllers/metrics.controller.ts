import {
  Controller,
  Get,
  Query,
  Inject,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DevelopmentGuard } from '../guards/development.guard';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import { WKG_SERVICE, SELF_KG_SERVICE } from '../../knowledge/knowledge.tokens';
import { DRIVE_STATE_READER } from '../../drive-engine/drive-engine.tokens';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { IWkgService, ISelfKgService } from '../../knowledge/interfaces/knowledge.interfaces';
import type { IDriveStateReader } from '../../drive-engine/interfaces/drive-engine.interfaces';
import type {
  Type1Type2Ratio,
  PredictionMAEMetric,
  ProvenanceRatio,
  BehavioralDiversityIndex,
  GuardianResponseRate,
  InteroceptiveAccuracy,
  MeanDriveResolutionTime,
  HealthMetrics,
} from '../../shared/types/metrics.types';
import type { MetricValue, MetricsResponse } from '../dtos/metrics.dto';
import { ObservatoryService } from '../services/observatory.service';
import type {
  VocabularyGrowthResponse,
  DriveEvolutionResponse,
  ActionDiversityResponse,
  DevelopmentalStageResponse,
  SessionComparisonResponse,
  ComprehensionAccuracyResponse,
  PhraseRecognitionResponse,
} from '../services/observatory.service';

/**
 * MetricsController — Health metrics and behavioral drift reporting.
 *
 * Exposes REST endpoints for the seven CANON primary health metrics:
 * Type 1/Type 2 ratio, prediction MAE, experiential provenance ratio,
 * behavioral diversity index, guardian response rate, interoceptive accuracy,
 * and mean drive resolution time.
 *
 * CANON §Development Metrics: These metrics instrument Sylphie's development
 * and detect attractor states. All endpoints are guarded by DevelopmentGuard.
 */
@Controller('api/metrics')
@UseGuards(DevelopmentGuard)
export class MetricsController {
  constructor(
    @Inject(EVENTS_SERVICE) private readonly events: IEventService,
    @Inject(WKG_SERVICE) private readonly wkg: IWkgService,
    @Inject(SELF_KG_SERVICE) private readonly selfKg: ISelfKgService,
    @Inject(DRIVE_STATE_READER) private readonly driveReader: IDriveStateReader,
    private readonly configService: ConfigService,
    private readonly observatory: ObservatoryService,
  ) {}

  /**
   * GET /api/metrics/health
   *
   * Compute all 7 CANON health metrics and return as MetricsResponse.
   * Each metric includes current value, trend ('improving'|'stable'|'declining'),
   * and historical data points for charting.
   *
   * CANON §Development Metrics: These seven metrics are the primary instrument
   * panel for tracking whether Sylphie is developing or stagnating.
   *
   * @returns MetricsResponse with all seven health metrics
   */
  @Get('health')
  async getHealthMetricsAlias(): Promise<MetricsResponse> {
    return this.getHealthMetrics();
  }

  @Get('observatory/alerts')
  getObservatoryAlerts(): { alerts: unknown[] } {
    return { alerts: [] };
  }

  @Get()
  async getHealthMetrics(): Promise<MetricsResponse> {
    const sessionId = this.configService.get<string>('SESSION_ID') ?? 'unknown';
    const now = Date.now();

    try {
      // Compute all seven metrics
      const type1Type2 = await this.computeType1Type2Ratio();
      const predictionMae = await this.computePredictionMAE();
      const provenance = await this.computeProvenanceRatio();
      const diversity = await this.computeBehavioralDiversityIndex();
      const guardianResponse = await this.computeGuardianResponseRate();
      const interoceptive = await this.computeInteroceptiveAccuracy();
      const driveResolution = await this.computeMeanDriveResolutionTimes();

      // Build MetricValue array with trend analysis
      const metrics: MetricValue[] = [
        {
          name: 'Type1Type2Ratio',
          value: type1Type2.ratio,
          trend: this.analyzeTrend(type1Type2.ratio, 'increasing'),
          history: [{ timestamp: now, value: type1Type2.ratio }],
        },
        {
          name: 'PredictionMAE',
          value: predictionMae.mae,
          trend: this.analyzeTrend(predictionMae.mae, 'decreasing'),
          history: [{ timestamp: now, value: predictionMae.mae }],
        },
        {
          name: 'ProvenanceRatio',
          value: provenance.experientialRatio,
          trend: this.analyzeTrend(provenance.experientialRatio, 'increasing'),
          history: [{ timestamp: now, value: provenance.experientialRatio }],
        },
        {
          name: 'BehavioralDiversityIndex',
          value: diversity.index,
          trend: this.analyzeTrend(diversity.index, 'stable'),
          history: [{ timestamp: now, value: diversity.index }],
        },
        {
          name: 'GuardianResponseRate',
          value: guardianResponse.rate,
          trend: this.analyzeTrend(guardianResponse.rate, 'increasing'),
          history: [{ timestamp: now, value: guardianResponse.rate }],
        },
        {
          name: 'InteroceptiveAccuracy',
          value: interoceptive.accuracy,
          trend: this.analyzeTrend(interoceptive.accuracy, 'increasing'),
          history: [{ timestamp: now, value: interoceptive.accuracy }],
        },
      ];

      // Add drive resolution times as separate metric values
      for (const [drive, resolution] of Object.entries(driveResolution)) {
        if (resolution) {
          metrics.push({
            name: `MeanDriveResolutionTime_${drive}`,
            value: resolution.meanMs,
            trend: this.analyzeTrend(resolution.meanMs, 'decreasing'),
            history: [{ timestamp: now, value: resolution.meanMs }],
          });
        }
      }

      return {
        metrics,
        timestamp: now,
      };
    } catch (error) {
      // Degraded mode: return zero-valued metrics
      return {
        metrics: [
          {
            name: 'Type1Type2Ratio',
            value: 0,
            trend: 'stable',
            history: [],
          },
        ],
        timestamp: now,
      };
    }
  }

  /**
   * GET /api/metrics/type-ratio?window=300000
   *
   * Time-windowed Type 1/Type 2 ratio.
   *
   * @param window Time window in milliseconds (default: 300000 = 5 min)
   * @returns Type1Type2Ratio metric
   */
  @Get('type-ratio')
  async getTypeRatio(
    @Query('window') window?: string,
  ): Promise<Type1Type2Ratio> {
    const windowMs = window ? parseInt(window, 10) : 300000;
    return this.computeType1Type2Ratio(windowMs);
  }

  /**
   * GET /api/metrics/predictions?window=300000
   *
   * Time-windowed prediction MAE.
   *
   * @param window Time window in milliseconds (default: 300000 = 5 min)
   * @returns PredictionMAEMetric
   */
  @Get('predictions')
  async getPredictions(
    @Query('window') window?: string,
  ): Promise<PredictionMAEMetric> {
    const windowMs = window ? parseInt(window, 10) : 300000;
    return this.computePredictionMAE(windowMs);
  }

  /**
   * GET /api/metrics/provenance
   *
   * Current provenance distribution from WKG.
   *
   * @returns ProvenanceRatio metric
   */
  @Get('provenance')
  async getProvenance(): Promise<ProvenanceRatio> {
    return this.computeProvenanceRatio();
  }

  // =========================================================================
  // Observatory endpoints
  // =========================================================================

  /**
   * GET /api/metrics/observatory/vocabulary-growth
   *
   * Daily WKG node creation counts, grouped by label and provenance.
   * Result is cached for 5 minutes by ObservatoryService.
   *
   * @returns VocabularyGrowthResponse with days array (empty if WKG unavailable)
   */
  @Get('observatory/vocabulary-growth')
  async getObservatoryVocabularyGrowth(): Promise<VocabularyGrowthResponse> {
    return this.observatory.getVocabularyGrowth();
  }

  /**
   * GET /api/metrics/observatory/drive-evolution
   *
   * Mean drive values per session from DRIVE_TICK events, extracted from
   * drive_snapshot->'pressureVector' JSONB.
   *
   * @returns DriveEvolutionResponse with sessions array (empty if TimescaleDB unavailable)
   */
  @Get('observatory/drive-evolution')
  async getObservatoryDriveEvolution(): Promise<DriveEvolutionResponse> {
    return this.observatory.getDriveEvolution();
  }

  /**
   * GET /api/metrics/observatory/action-diversity
   *
   * Unique actionType counts per session from OUTCOME_PROCESSED events.
   *
   * @returns ActionDiversityResponse with sessions array (empty if TimescaleDB unavailable)
   */
  @Get('observatory/action-diversity')
  async getObservatoryActionDiversity(): Promise<ActionDiversityResponse> {
    return this.observatory.getActionDiversity();
  }

  /**
   * GET /api/metrics/observatory/developmental-stage
   *
   * TYPE_1_DECISION vs TYPE_2_DECISION event counts per session.
   * Returns pre-autonomy stage with zero data if no decision events exist yet.
   *
   * @returns DevelopmentalStageResponse with sessions array and overall stage
   */
  @Get('observatory/developmental-stage')
  async getObservatoryDevelopmentalStage(): Promise<DevelopmentalStageResponse> {
    return this.observatory.getDevelopmentalStage();
  }

  /**
   * GET /api/metrics/observatory/session-comparison
   *
   * All closed sessions with a persisted metrics_snapshot.
   *
   * @returns SessionComparisonResponse with sessions array (empty if no closed sessions)
   */
  @Get('observatory/session-comparison')
  async getObservatorySessionComparison(): Promise<SessionComparisonResponse> {
    return this.observatory.getSessionComparison();
  }

  /**
   * GET /api/metrics/observatory/comprehension-accuracy
   *
   * AVG absoluteError per session from PREDICTION_EVALUATED events.
   * Returns empty sessions array if no evaluation events exist yet.
   *
   * @returns ComprehensionAccuracyResponse with sessions array
   */
  @Get('observatory/comprehension-accuracy')
  async getObservatoryComprehensionAccuracy(): Promise<ComprehensionAccuracyResponse> {
    return this.observatory.getComprehensionAccuracy();
  }

  /**
   * GET /api/metrics/observatory/phrase-recognition
   *
   * Utterance nodes above the 0.50 retrieval threshold, grouped by provenance.
   *
   * @returns PhraseRecognitionResponse (zeros if WKG unavailable)
   */
  @Get('observatory/phrase-recognition')
  async getObservatoryPhraseRecognition(): Promise<PhraseRecognitionResponse> {
    return this.observatory.getPhraseRecognition();
  }

  // =========================================================================
  // Private computation methods
  // =========================================================================

  /**
   * Compute Type 1/Type 2 ratio from ACTION_EXECUTED events.
   *
   * Ratio = type1Count / (type1Count + type2Count).
   * NaN if both counts are zero.
   */
  private async computeType1Type2Ratio(windowMs: number = 3600000): Promise<Type1Type2Ratio> {
    const now = new Date();
    const start = new Date(now.getTime() - windowMs);

    const events = await this.events.query({
      types: ['ACTION_EXECUTED'],
      startTime: start,
      endTime: now,
      limit: 1000,
    });

    let type1Count = 0;
    let type2Count = 0;

    for (const evt of events) {
      const payload = evt as any;
      if (payload.arbitrationType === 'TYPE_1') {
        type1Count += 1;
      } else if (payload.arbitrationType === 'TYPE_2') {
        type2Count += 1;
      }
    }

    const total = type1Count + type2Count;
    const ratio = total > 0 ? type1Count / total : NaN;

    return {
      type1Count,
      type2Count,
      ratio,
      windowSize: total,
      computedAt: now,
    };
  }

  /**
   * Compute prediction MAE from PREDICTION_EVALUATED events.
   *
   * MAE = mean of absolute errors across the sample window.
   */
  private async computePredictionMAE(windowMs: number = 3600000): Promise<PredictionMAEMetric> {
    const now = new Date();
    const start = new Date(now.getTime() - windowMs);

    const events = await this.events.query({
      types: ['PREDICTION_EVALUATED'],
      startTime: start,
      endTime: now,
      limit: 1000,
    });

    if (events.length === 0) {
      return {
        mae: 0,
        sampleCount: 0,
        windowSize: 10,
        computedAt: now,
      };
    }

    let sumError = 0;
    for (const evt of events) {
      const payload = evt as any;
      sumError += payload.absoluteError ?? 0;
    }

    const mae = sumError / events.length;

    return {
      mae,
      sampleCount: events.length,
      windowSize: 10,
      computedAt: now,
    };
  }

  /**
   * Compute experiential provenance ratio from WKG node statistics.
   *
   * experimentalRatio = (sensor + guardian + inference) / total.
   */
  private async computeProvenanceRatio(): Promise<ProvenanceRatio> {
    const now = new Date();

    try {
      const stats = await this.wkg.queryGraphStats();

      const sensor = (stats.byProvenance as Record<string, number>)['SENSOR'] ?? 0;
      const guardian = (stats.byProvenance as Record<string, number>)['GUARDIAN'] ?? 0;
      const llmGenerated = (stats.byProvenance as Record<string, number>)['LLM_GENERATED'] ?? 0;
      const inference = (stats.byProvenance as Record<string, number>)['INFERENCE'] ?? 0;
      const total = stats.totalNodes;

      const experiential = sensor + guardian + inference;
      const experientialRatio = total > 0 ? experiential / total : NaN;

      return {
        sensor,
        guardian,
        llmGenerated,
        inference,
        total,
        experientialRatio,
        computedAt: now,
      };
    } catch {
      return {
        sensor: 0,
        guardian: 0,
        llmGenerated: 0,
        inference: 0,
        total: 0,
        experientialRatio: NaN,
        computedAt: now,
      };
    }
  }

  /**
   * Compute behavioral diversity index from last 20 ACTION_EXECUTED events.
   *
   * Diversity = uniqueActionTypes / windowSize.
   * Per CANON: healthy range is 4-8 unique types per 20-action window.
   */
  private async computeBehavioralDiversityIndex(): Promise<BehavioralDiversityIndex> {
    const now = new Date();

    const events = await this.events.query({
      types: ['ACTION_EXECUTED'],
      limit: 20,
    });

    const actionTypes = new Set<string>();
    for (const evt of events) {
      const payload = evt as any;
      if (payload.actionType) {
        actionTypes.add(payload.actionType);
      }
    }

    const windowSize = 20;
    const uniqueActionTypes = actionTypes.size;
    const index = windowSize > 0 ? uniqueActionTypes / windowSize : 0;

    return {
      uniqueActionTypes,
      windowSize,
      index,
      computedAt: now,
    };
  }

  /**
   * Compute guardian response rate from SOCIAL_COMMENT_INITIATED and
   * SOCIAL_CONTINGENCY_MET events.
   *
   * Rate = responded / initiated. NaN if initiated is zero.
   */
  private async computeGuardianResponseRate(): Promise<GuardianResponseRate> {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3600000);

    const [initiated, contingency] = await Promise.all([
      this.events.query({
        types: ['SOCIAL_COMMENT_INITIATED'],
        startTime: oneHourAgo,
        endTime: now,
        limit: 1000,
      }),
      this.events.query({
        types: ['SOCIAL_CONTINGENCY_MET'],
        startTime: oneHourAgo,
        endTime: now,
        limit: 1000,
      }),
    ]);

    const initiatedCount = initiated.length;
    const respondedCount = contingency.length;
    const rate = initiatedCount > 0 ? respondedCount / initiatedCount : NaN;

    return {
      initiated: initiatedCount,
      responded: respondedCount,
      rate,
      computedAt: now,
    };
  }

  /**
   * Compute interoceptive accuracy by comparing Self KG self-reported drive
   * state with actual Drive Engine state.
   *
   * Accuracy = 1.0 - |selfReported - actual|.
   */
  private async computeInteroceptiveAccuracy(): Promise<InteroceptiveAccuracy> {
    const now = new Date();

    try {
      // Get current drive state from Drive Engine
      const driveSnapshot = this.driveReader.getCurrentState();
      const actualNormalized = Math.min(1.0, driveSnapshot.totalPressure / 12); // Normalize across 12 drives

      // Get self-reported state from Self KG (simplified approximation)
      // In a full implementation, this would read from KG(Self) self-evaluation nodes
      const selfReported = 0.5; // Placeholder

      const accuracy = 1.0 - Math.abs(selfReported - actualNormalized);

      return {
        selfReported,
        actual: actualNormalized,
        accuracy,
        computedAt: now,
      };
    } catch {
      return {
        selfReported: 0,
        actual: 0,
        accuracy: 0,
        computedAt: now,
      };
    }
  }

  /**
   * Compute mean drive resolution time from DRIVE_RELIEF events.
   *
   * For each drive: mean time from pressure > 0.5 to relief < 0.3.
   * Partial map — only drives with sampleCount >= 5 included.
   */
  private async computeMeanDriveResolutionTimes(): Promise<Partial<Record<string, MeanDriveResolutionTime>>> {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3600000);

    const reliefEvents = await this.events.query({
      types: ['DRIVE_RELIEF'],
      startTime: oneHourAgo,
      endTime: now,
      limit: 1000,
    });

    // Group by drive and compute mean resolution time
    const driveResolutions: Record<string, number[]> = {};

    for (const evt of reliefEvents) {
      const payload = evt as any;
      const drive = payload.drive ?? 'unknown';
      const resolutionTime = payload.resolutionTimeMs ?? 0;

      if (!driveResolutions[drive]) {
        driveResolutions[drive] = [];
      }
      driveResolutions[drive].push(resolutionTime);
    }

    // Build result, filtering for sampleCount >= 5
    const result: Partial<Record<string, MeanDriveResolutionTime>> = {};

    for (const [drive, times] of Object.entries(driveResolutions)) {
      if (times.length >= 5) {
        const mean = times.reduce((a, b) => a + b, 0) / times.length;
        result[drive] = {
          drive,
          meanMs: mean,
          sampleCount: times.length,
          computedAt: now,
        };
      }
    }

    return result;
  }

  /**
   * Analyze trend direction (improving/stable/declining) based on metric value.
   *
   * Simple heuristic: if the direction matches the desired trajectory, mark as
   * 'stable' (placeholder implementation). Full implementation would compare
   * against historical window.
   */
  private analyzeTrend(
    value: number,
    desiredDirection: 'increasing' | 'decreasing' | 'stable',
  ): 'improving' | 'stable' | 'declining' {
    // Placeholder: return 'stable' for all metrics
    // Full implementation would maintain historical sliding window
    return 'stable';
  }
}
