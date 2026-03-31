/**
 * Read-only interface for querying KG(Self) from the Drive Engine.
 *
 * KG(Self) is a Grafeo graph maintained by the Learning subsystem.
 * The Drive Engine reads from it on a slower timescale to adjust drive
 * baselines based on self-assessed capabilities and drive patterns.
 *
 * CANON §E4-T008: Drive Engine reads KG(Self) every 10 ticks (~100ms)
 * to prevent identity lock-in ("system permanently thinks it's bad at X").
 *
 * No cross-subsystem dependencies. This is a read-only contract.
 */

import { DriveName } from '../../shared/types/drive.types';

/**
 * Represents a capability (skill or function) that Sylphie can perform.
 * Stored in KG(Self), queried by the Drive Engine for baseline adjustment.
 */
export interface SelfCapability {
  /** Unique identifier for this capability */
  id: string;

  /** Human-readable name (e.g., "social_interaction", "prediction_accuracy") */
  name: string;

  /**
   * Success rate of this capability over recent uses.
   * Range [0.0, 1.0]. Computed from historical execution records in KG(Self).
   * Used to adjust drive baselines: low rate (< 0.3) reduces baseline.
   */
  successRate: number;

  /** Timestamp of the last execution of this capability */
  lastExecuted: Date;

  /**
   * Confidence in this success rate estimate.
   * Range [0.0, 1.0]. Higher confidence = more samples analyzed.
   * Low confidence assessments may be ignored or weighted lower.
   */
  confidence: number;

  /** Sample count used to compute successRate */
  sampleCount: number;
}

/**
 * Represents a learned association between a drive and a stimulus/response.
 * Stored in KG(Self), used to understand Sylphie's behavioral patterns.
 */
export interface DrivePattern {
  /** The drive involved (e.g., Social, Curiosity) */
  drive: DriveName;

  /**
   * Human-readable stimulus description
   * (e.g., "receives social feedback", "encounters new information")
   */
  stimulus: string;

  /**
   * Typical response strength [0.0, 1.0].
   * How strongly this drive typically responds to the stimulus.
   */
  responseStrength: number;

  /** Example instances (strings) of this pattern being observed */
  examples: string[];

  /** Timestamp of the most recent observation */
  lastObserved: Date;

  /** Confidence in this pattern (higher = more observations) */
  confidence: number;
}

/**
 * Represents prediction accuracy in a specific domain.
 * Used to assess Integrity drive baseline (prediction quality).
 */
export interface PredictionAccuracy {
  /** Domain name (e.g., "user_behavior", "action_outcomes") */
  domain: string;

  /**
   * Mean Absolute Error of predictions in this domain.
   * Lower is better. Range [0.0, 1.0] or can exceed for certain domains.
   * Used to assess Integrity drive pressure.
   */
  mae: number;

  /** Number of predictions analyzed */
  sampleCount: number;

  /** Confidence in this MAE estimate */
  confidence: number;

  /** Timestamp of the last prediction in this domain */
  lastUpdated: Date;
}

/**
 * Read-only interface for querying KG(Self).
 *
 * Implemented by a Grafeo adapter in the Drive Engine process.
 * All queries are read-only and return fresh data on each call
 * (or null if data unavailable).
 *
 * CRITICAL: This interface is read-only. The Drive Engine must NEVER
 * write to KG(Self). All writes come from the Learning subsystem.
 */
export interface ISelfKgReader {
  /**
   * Query all capabilities from KG(Self).
   * Returns array of current capabilities, or empty array if KG(Self) unavailable.
   *
   * @returns Promise<SelfCapability[]> Array of capabilities
   */
  queryCapabilities(): Promise<SelfCapability[]>;

  /**
   * Query all drive patterns associated with a specific drive.
   *
   * @param drive The drive to query patterns for
   * @returns Promise<DrivePattern[]> Array of patterns for that drive, or empty array
   */
  queryDrivePatterns(drive: DriveName): Promise<DrivePattern[]>;

  /**
   * Query prediction accuracy in a specific domain.
   *
   * @param domain Domain name to query
   * @returns Promise<PredictionAccuracy | null> The accuracy record, or null if not found
   */
  queryPredictionAccuracy(domain: string): Promise<PredictionAccuracy | null>;

  /**
   * Check if the reader is available/connected.
   * Used to determine whether to skip self-evaluation if KG(Self) is unavailable.
   *
   * @returns boolean True if ready to query
   */
  isReady(): boolean;
}
