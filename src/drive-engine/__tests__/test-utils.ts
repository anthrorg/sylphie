/**
 * Test utilities for Drive Engine unit and integration tests.
 *
 * Provides factory functions for creating mock payloads and drive snapshots
 * used across the test suite.
 */

import { DriveName, INITIAL_DRIVE_STATE, DriveSnapshot } from '../../shared/types/drive.types';
import { ActionOutcomePayload, SoftwareMetricsPayload } from '../../shared/types/ipc.types';

/**
 * Create a mock ActionOutcomePayload for testing.
 *
 * Provides sensible defaults for all required fields. Override any field by
 * passing an overrides object.
 *
 * @param overrides - Partial object to override defaults
 * @returns A complete ActionOutcomePayload
 */
export function createMockOutcome(
  overrides?: Partial<ActionOutcomePayload>,
): ActionOutcomePayload {
  return {
    actionId: 'test-action-id',
    actionType: 'test-action',
    outcome: 'positive',
    driveEffects: {
      [DriveName.Satisfaction]: 0.1,
    },
    feedbackSource: 'algorithmic',
    theaterCheck: {
      expressionType: 'none',
      driveValueAtExpression: 0.0,
      drive: DriveName.Satisfaction,
      isTheatrical: false,
    },
    anxietyAtExecution: 0.3,
    ...overrides,
  };
}

/**
 * Create a mock SoftwareMetricsPayload for testing.
 *
 * @param overrides - Partial object to override defaults
 * @returns A complete SoftwareMetricsPayload
 */
export function createMockMetrics(
  overrides?: Partial<SoftwareMetricsPayload>,
): SoftwareMetricsPayload {
  return {
    llmCallCount: 1,
    llmLatencyMs: 100,
    tokenCount: 500,
    cognitiveEffortPressure: 0.1,
    estimatedCostUsd: 0.01,
    windowStartAt: new Date(Date.now() - 5000),
    windowEndAt: new Date(),
    ...overrides,
  };
}

/**
 * Create a mock DriveSnapshot for testing.
 *
 * Provides sensible defaults based on INITIAL_DRIVE_STATE. Override any drive
 * value by passing a partial pressureVector override.
 *
 * @param overrides - Partial object with pressureVector and tickNumber overrides
 * @returns A complete DriveSnapshot
 */
export function createMockDriveSnapshot(overrides?: {
  pressureVector?: Partial<Record<DriveName, number>>;
  tickNumber?: number;
}): DriveSnapshot {
  const pressureVector = {
    ...INITIAL_DRIVE_STATE,
    ...overrides?.pressureVector,
  } as Record<DriveName, number>;

  // Compute driveDeltas (all zeros by default)
  const driveDeltas: Record<DriveName, number> = Object.fromEntries(
    Object.keys(pressureVector).map((key) => [key, 0]),
  ) as Record<DriveName, number>;

  // Compute totalPressure (sum of positive drives)
  const totalPressure = Object.values(pressureVector).reduce(
    (sum, value) => sum + Math.max(0, value),
    0,
  );

  return {
    tickNumber: overrides?.tickNumber || 0,
    timestamp: new Date(),
    pressureVector: pressureVector as any,
    driveDeltas: driveDeltas as any,
    ruleMatchResult: {
      ruleId: null,
      eventType: 'test-event',
      matched: false,
    },
    totalPressure,
    sessionId: 'test-session',
  };
}

/**
 * Create a mock PressureVector (just the drive values part of a snapshot).
 *
 * @param overrides - Partial drives to override
 * @returns A complete PressureVector
 */
export function createMockPressureVector(
  overrides?: Partial<Record<DriveName, number>>,
): Record<DriveName, number> {
  return {
    ...INITIAL_DRIVE_STATE,
    ...overrides,
  };
}

/**
 * Wait for a condition to become true, with configurable timeout.
 *
 * Useful for async tests that need to wait for state changes.
 *
 * @param fn - Function that returns true when the condition is met
 * @param timeout - Maximum time to wait in milliseconds (default: 1000)
 * @returns Promise that resolves when condition is true, rejects on timeout
 */
export async function waitForCondition(
  fn: () => boolean,
  timeout: number = 1000,
): Promise<void> {
  const startTime = Date.now();
  const pollInterval = 10; // Check every 10ms

  while (!fn()) {
    if (Date.now() - startTime > timeout) {
      throw new Error(`Condition not met within ${timeout}ms timeout`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}
