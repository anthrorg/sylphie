/**
 * Database client adapters for the Drive Engine child process.
 *
 * The Drive Engine is isolated in a child process under the event-judge model:
 * there is NO drive→main read path. KG(Self) data reaches the drive ONLY as a
 * pushed SELF_ASSESSMENT inbound message, cached by CachedSelfKgReader below and
 * served to the self-evaluation loop on its own cadence (never by querying MAIN).
 *
 * CANON §E4-T008: KG(Self) is consumed on a slower timescale (every 10 ticks).
 * FallbackSelfKgReader is the neutral no-data stand-in used at bootstrap (before
 * the first push) and in tests — it returns empty/null so the loop runs with no
 * baseline adjustment (safe neutral). It is NOT a pull path.
 */

import {
  ISelfKgReader,
  SelfCapability,
  DrivePattern,
  PredictionAccuracy,
} from '../interfaces/self-kg.interfaces';
import { DriveName, type SelfAssessmentPayload } from '@sylphie/shared';

/**
 * CANON Standard 3 (Confidence Ceiling): system-inferred confidence may not
 * exceed 0.60 until guardian-confirmed. Capability confidence from a
 * SELF_ASSESSMENT is clamped to this ceiling unless provenance is GUARDIAN.
 */
const STD3_CONFIDENCE_CEILING = 0.6;

/**
 * Neutral no-data reader. Every query returns empty/null, so the
 * self-evaluation loop runs without producing any baseline adjustment
 * (neutral capability = no adjustment). Used at bootstrap before the first
 * SELF_ASSESSMENT push lands and as the default test injection.
 *
 * NOT a pull path: real KG(Self) data arrives via CachedSelfKgReader (push-fed
 * by SELF_ASSESSMENT). This reader never contacts MAIN — the event-judge model
 * forbids a drive→main read path.
 */
export class FallbackSelfKgReader implements ISelfKgReader {
  private ready: boolean = true;

  /**
   * Neutral: no capabilities. Real capability data arrives via the pushed
   * SELF_ASSESSMENT (CachedSelfKgReader), not from here.
   */
  async queryCapabilities(): Promise<SelfCapability[]> {
    return [];
  }

  /**
   * Neutral: no drive patterns. Drive patterns are informational and arrive
   * via the pushed SELF_ASSESSMENT, not from here.
   */
  async queryDrivePatterns(drive: DriveName): Promise<DrivePattern[]> {
    return [];
  }

  /**
   * Neutral: no prediction accuracy. Real data arrives via the pushed
   * SELF_ASSESSMENT, not from here.
   */
  async queryPredictionAccuracy(domain: string): Promise<PredictionAccuracy | null> {
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
