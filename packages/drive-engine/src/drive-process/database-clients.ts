/**
 * Database client adapters for the Drive Engine child process.
 *
 * The Drive Engine is isolated in a child process with one-way IPC to the main
 * NestJS process. This module provides adapters for reading from databases
 * (particularly KG(Self) via Grafeo) through IPC fallback mechanisms.
 *
 * CANON §E4-T008: KG(Self) reads on slower timescale (every 10 ticks).
 * Since the child process cannot directly access Grafeo, we provide a stub
 * that returns neutral default data. Future implementation will use IPC to
 * query the main process.
 */

import {
  ISelfKgReader,
  SelfCapability,
  DrivePattern,
  PredictionAccuracy,
} from '../interfaces/self-kg.interfaces';
import { DriveName, type SelfAssessmentPayload } from '@sylphie/shared';
import { SELF_KG_QUERY_TIMEOUT_MS } from '../constants/self-evaluation';

/**
 * CANON Standard 3 (Confidence Ceiling): system-inferred confidence may not
 * exceed 0.60 until guardian-confirmed. Capability confidence from a
 * SELF_ASSESSMENT is clamped to this ceiling unless provenance is GUARDIAN.
 */
const STD3_CONFIDENCE_CEILING = 0.6;

/**
 * Fallback adapter for reading KG(Self) when IPC is not available.
 *
 * For Phase 1, this returns neutral default data:
 * - All capabilities have successRate = 0.5 (neutral)
 * - No drive patterns
 * - No prediction accuracy data
 *
 * This allows the self-evaluation loop to run without modification,
 * but with no actual baseline adjustment (neutral capability = no adjustment).
 *
 * TODO: Implement IPC-based queries to main process for real Grafeo access.
 */
export class FallbackSelfKgReader implements ISelfKgReader {
  private ready: boolean = true;

  /**
   * Query all capabilities from KG(Self).
   *
   * For Phase 1, returns empty array (no capabilities defined yet).
   * This prevents unnecessary adjustments until KG(Self) is populated.
   *
   * @returns Promise<SelfCapability[]> Empty array
   */
  async queryCapabilities(): Promise<SelfCapability[]> {
    // TODO: Replace with actual Grafeo query via IPC
    // For now, return empty array to indicate no self-assessment data available
    return [];
  }

  /**
   * Query drive patterns for a specific drive.
   *
   * For Phase 1, returns empty array.
   * Drive patterns are informational but not used for baseline adjustment.
   *
   * @param drive The drive to query
   * @returns Promise<DrivePattern[]> Empty array
   */
  async queryDrivePatterns(drive: DriveName): Promise<DrivePattern[]> {
    // TODO: Replace with actual Grafeo query via IPC
    return [];
  }

  /**
   * Query prediction accuracy in a specific domain.
   *
   * For Phase 1, returns null.
   * Once prediction accuracy is stored in KG(Self), this will
   * be used to adjust Integrity drive baseline.
   *
   * @param domain Domain to query
   * @returns Promise<PredictionAccuracy | null> Null
   */
  async queryPredictionAccuracy(domain: string): Promise<PredictionAccuracy | null> {
    // TODO: Replace with actual Grafeo query via IPC
    return null;
  }

  /**
   * Check if the reader is ready.
   *
   * @returns boolean Always true for fallback
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Disable the reader (for testing).
   */
  public disable(): void {
    this.ready = false;
  }

  /**
   * Re-enable the reader (for testing).
   */
  public enable(): void {
    this.ready = true;
  }
}

/**
 * IPC-based adapter for reading KG(Self) from the main process.
 *
 * For future implementation: sends queries to the main NestJS process
 * and receives Grafeo results back through IPC.
 *
 * TODO: Implement when IPC query channel is available.
 */
export class IPCSelfKgReader implements ISelfKgReader {
  private ready: boolean = false;

  constructor() {
    // TODO: Initialize IPC channel to main process
    // For now, mark as not ready
    this.ready = false;
  }

  async queryCapabilities(): Promise<SelfCapability[]> {
    // TODO: Send IPC_QUERY_SELF_KG_CAPABILITIES, await response with timeout
    return [];
  }

  async queryDrivePatterns(drive: DriveName): Promise<DrivePattern[]> {
    // TODO: Send IPC_QUERY_SELF_KG_PATTERNS, await response with timeout
    return [];
  }

  async queryPredictionAccuracy(domain: string): Promise<PredictionAccuracy | null> {
    // TODO: Send IPC_QUERY_SELF_KG_PREDICTION_ACCURACY, await response with timeout
    return null;
  }

  isReady(): boolean {
    return this.ready;
  }
}

/**
 * Cached adapter for reading KG(Self) under the event-judge model.
 *
 * CANON §Drive Isolation (event-judge model): there is NO drive→main read path.
 * MAIN computes a KG(Self) self-assessment from Grafeo and PUSHES it as a
 * SELF_ASSESSMENT inbound message. This reader caches the latest pushed
 * snapshot and serves it to the self-evaluation loop on its own 10-tick cadence
 * — decoupled and non-blocking. The reader never queries MAIN.
 *
 * Degradation (never fabricate):
 *   - Before the first push: latest === null → isReady() false → the self
 *     evaluator skips → no baseline adjustment = today's safe neutral.
 *   - Stale cache: the serving methods still return the last snapshot; the
 *     baseline-adjustment layer self-heals toward default via applyGeneralRecovery.
 *
 * CANON Standard 3 (Confidence Ceiling): on mapping, capability confidence is
 * clamped to ≤0.60 unless provenance === 'GUARDIAN'.
 *
 * Depressive Attractor guard: for non-GUARDIAN provenance the mapped
 * SelfCapability carries allowReduction=false, so an inferred "I'm bad at X"
 * cannot push a drive baseline downward (only recovery toward default is
 * permitted). GUARDIAN / GUARDIAN_APPROVED_INFERENCE may reduce.
 */
export class CachedSelfKgReader implements ISelfKgReader {
  private latest: SelfAssessmentPayload | null = null;

  /**
   * Cache the latest pushed self-assessment. Called from the SELF_ASSESSMENT
   * IPC routing on receipt. Cheap — just stores the reference; the self-eval
   * loop reads it on its own cadence.
   */
  public ingest(payload: SelfAssessmentPayload): void {
    this.latest = payload;
  }

  /**
   * Whether baseline reduction is permitted for the cached provenance.
   * Only guardian-sourced assessments (confirmed or approved-inference) may
   * push a baseline down. Inference / bootstrap may not.
   */
  private reductionAllowed(): boolean {
    if (!this.latest) {
      return false;
    }
    return (
      this.latest.provenance === 'GUARDIAN' ||
      this.latest.provenance === 'GUARDIAN_APPROVED_INFERENCE'
    );
  }

  /**
   * Clamp confidence to the Std-3 ceiling unless the snapshot is GUARDIAN.
   */
  private clampConfidence(confidence: number): number {
    if (this.latest && this.latest.provenance === 'GUARDIAN') {
      return confidence;
    }
    return Math.min(confidence, STD3_CONFIDENCE_CEILING);
  }

  async queryCapabilities(): Promise<SelfCapability[]> {
    if (!this.latest) {
      return [];
    }
    const allowReduction = this.reductionAllowed();
    return this.latest.capabilities.map((cap) => ({
      id: cap.id,
      name: cap.name,
      successRate: cap.successRate,
      lastExecuted: cap.lastExecuted,
      confidence: this.clampConfidence(cap.confidence),
      sampleCount: cap.sampleCount,
      allowReduction,
    }));
  }

  async queryDrivePatterns(drive: DriveName): Promise<DrivePattern[]> {
    if (!this.latest) {
      return [];
    }
    return this.latest.drivePatterns
      .filter((p) => p.drive === drive)
      .map((p) => ({
        drive: p.drive,
        stimulus: p.stimulus,
        responseStrength: p.responseStrength,
        examples: [...p.examples],
        lastObserved: p.lastObserved,
        confidence: this.clampConfidence(p.confidence),
      }));
  }

  async queryPredictionAccuracy(domain: string): Promise<PredictionAccuracy | null> {
    if (!this.latest) {
      return null;
    }
    const match = this.latest.predictionAccuracy.find((pa) => pa.domain === domain);
    if (!match) {
      return null;
    }
    return {
      domain: match.domain,
      mae: match.mae,
      sampleCount: match.sampleCount,
      confidence: this.clampConfidence(match.confidence),
      lastUpdated: match.lastUpdated,
    };
  }

  /**
   * Ready only after the first push. Before that the self evaluator must skip,
   * yielding today's safe neutral (no adjustment).
   */
  isReady(): boolean {
    return this.latest !== null;
  }
}

/**
 * Get or create the global KG(Self) reader.
 *
 * Event-judge model: uses CachedSelfKgReader, fed by SELF_ASSESSMENT pushes.
 * Tests still inject FallbackSelfKgReader via setSelfKgReader().
 */
let selfKgReader: ISelfKgReader | null = null;

export function getOrCreateSelfKgReader(): ISelfKgReader {
  if (!selfKgReader) {
    selfKgReader = new CachedSelfKgReader();
  }
  return selfKgReader;
}

/**
 * Set the KG(Self) reader (for testing).
 */
export function setSelfKgReader(reader: ISelfKgReader): void {
  selfKgReader = reader;
}

/**
 * Reset the KG(Self) reader (for testing).
 */
export function resetSelfKgReader(): void {
  selfKgReader = null;
}
