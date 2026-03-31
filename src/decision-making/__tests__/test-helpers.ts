/**
 * Test helpers for Decision Making subsystem tests.
 * Provides factories for creating mock data structures.
 */

import { randomUUID } from 'crypto';
import { DriveSnapshot, DriveName } from '../../shared/types/drive.types';
import { ActionCandidate, ActionProcedureData, ExecutorState } from '../../shared/types/action.types';
import { EpisodeInput } from '../interfaces/decision-making.interfaces';

/**
 * Create a mock drive snapshot with all drives set to neutral (0.0).
 * Override specific drives as needed in tests.
 */
export function createMockDriveSnapshot(overrides?: Partial<DriveSnapshot>): DriveSnapshot {
  const pressureVector = {
    [DriveName.SystemHealth]: 0.0,
    [DriveName.MoralValence]: 0.0,
    [DriveName.Integrity]: 0.0,
    [DriveName.CognitiveAwareness]: 0.0,
    [DriveName.Guilt]: 0.0,
    [DriveName.Curiosity]: 0.0,
    [DriveName.Boredom]: 0.0,
    [DriveName.Anxiety]: 0.0,
    [DriveName.Satisfaction]: 0.0,
    [DriveName.Sadness]: 0.0,
    [DriveName.InformationIntegrity]: 0.0,
    [DriveName.Social]: 0.0,
  };

  const driveDeltas = { ...pressureVector };

  return {
    pressureVector,
    timestamp: new Date(),
    tickNumber: 0,
    driveDeltas,
    ruleMatchResult: {
      ruleId: null,
      eventType: 'PREDICTION_MAE_SAMPLE',
      matched: false,
    },
    totalPressure: 0.0,
    sessionId: randomUUID(),
    ...overrides,
  };
}

/**
 * Create a mock action procedure data.
 */
export function createMockActionProcedure(
  overrides?: Partial<ActionProcedureData>,
): ActionProcedureData {
  return {
    id: randomUUID(),
    name: 'test-action',
    category: 'ConversationalResponse',
    triggerContext: 'test context',
    actionSequence: [
      {
        index: 0,
        stepType: 'LLM_GENERATE',
        params: { prompt: 'test' },
      },
    ],
    provenance: 'LLM_GENERATED',
    confidence: 0.7,
    ...overrides,
  };
}

/**
 * Create a mock action candidate.
 */
export function createMockActionCandidate(
  overrides?: Partial<ActionCandidate>,
): ActionCandidate {
  return {
    procedureData: createMockActionProcedure(),
    confidence: 0.75,
    motivatingDrive: DriveName.Curiosity,
    contextMatchScore: 0.8,
    ...overrides,
  };
}

/**
 * Create a mock episode input.
 */
export function createMockEpisodeInput(
  overrides?: Partial<EpisodeInput>,
): EpisodeInput {
  return {
    driveSnapshot: createMockDriveSnapshot(),
    inputSummary: 'Test input summary',
    actionTaken: 'test-action-id',
    contextFingerprint: 'test context fingerprint',
    attention: 0.5,
    arousal: 0.5,
    ...overrides,
  };
}
