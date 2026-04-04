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
import { DriveName } from '@sylphie/shared';
import { SELF_KG_QUERY_TIMEOUT_MS } from '../constants/self-evaluation';

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
 * Get or create the global KG(Self) reader.
 *
 * For Phase 1, uses the fallback adapter.
 * Future: will switch to IPCSelfKgReader when IPC is available.
 */
let selfKgReader: ISelfKgReader | null = null;

export function getOrCreateSelfKgReader(): ISelfKgReader {
  if (!selfKgReader) {
    // Phase 1: Use fallback adapter
    selfKgReader = new FallbackSelfKgReader();

    // TODO: Phase 2: Switch to IPCSelfKgReader when IPC infrastructure ready
    // selfKgReader = new IPCSelfKgReader();
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
