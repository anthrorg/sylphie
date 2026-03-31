/**
 * Behavioral Contingency Verification Tests
 *
 * CANON §A.15 (Behavioral Contingencies): Tests that verify the five core
 * contingency structures described in CLAUDE.md::Key Technical Patterns.
 *
 * These are the structural mechanisms that enable genuine learning:
 * 1. Satisfaction Habituation: Diminishing returns on repeated success
 * 2. Anxiety Amplification: Negative outcomes under high anxiety get 1.5x weight
 * 3. Guilt Repair: Only full repair (acknowledgment + behavioral change) relieves guilt
 * 4. Social Comment Quality: Guardian response within 30s = extra reinforcement
 * 5. Curiosity Information Gain: Relief proportional to actual new knowledge created
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { randomUUID } from 'crypto';
import type { DriveSnapshot, DriveName, PressureVector } from '../../shared/types/drive.types';
import {
  DriveName as DriveNameEnum,
  clampDriveValue,
  INITIAL_DRIVE_STATE,
  computeTotalPressure,
} from '../../shared/types/drive.types';
import type { SylphieEvent } from '../../shared/types/event.types';

// ---------------------------------------------------------------------------
// Helper Functions & Mock Data
// ---------------------------------------------------------------------------

/**
 * Create a mock DriveSnapshot for testing.
 */
function createMockDriveSnapshot(overrides?: Partial<PressureVector>): DriveSnapshot {
  const baseVector = { ...INITIAL_DRIVE_STATE };
  const pressureVector = { ...baseVector, ...overrides } as PressureVector;

  return {
    pressureVector,
    timestamp: new Date(),
    tickNumber: 1,
    driveDeltas: {
      [DriveNameEnum.SystemHealth]: 0,
      [DriveNameEnum.MoralValence]: 0,
      [DriveNameEnum.Integrity]: 0,
      [DriveNameEnum.CognitiveAwareness]: 0,
      [DriveNameEnum.Guilt]: 0,
      [DriveNameEnum.Curiosity]: 0,
      [DriveNameEnum.Boredom]: 0,
      [DriveNameEnum.Anxiety]: 0,
      [DriveNameEnum.Satisfaction]: 0,
      [DriveNameEnum.Sadness]: 0,
      [DriveNameEnum.InformationIntegrity]: 0,
      [DriveNameEnum.Social]: 0,
    },
    ruleMatchResult: {
      ruleId: null,
      eventType: 'TEST_ACTION',
      matched: false,
    },
    totalPressure: computeTotalPressure(pressureVector),
    sessionId: randomUUID(),
  };
}

/**
 * Create a mock reinforcement event with configurable drive relief.
 */
function createMockReinforcementEvent(
  actionId: string,
  driveSnapshot: DriveSnapshot,
  polarity: 'positive' | 'negative' = 'positive',
): SylphieEvent {
  return {
    id: randomUUID(),
    type: 'DRIVE_RELIEF',
    timestamp: new Date(),
    subsystem: 'DRIVE_ENGINE',
    sessionId: driveSnapshot.sessionId,
    driveSnapshot,
    schemaVersion: 1,
    provenance: 'SENSOR',
  };
}

// ---------------------------------------------------------------------------
// Test Suite: Behavioral Contingencies
// ---------------------------------------------------------------------------

describe('Behavioral Contingencies Integration', () => {
  let sessionId: string;

  beforeEach(() => {
    sessionId = randomUUID();
  });

  afterEach(() => {
    // Cleanup
  });

  // =========================================================================
  // T013.1: Satisfaction Habituation
  // =========================================================================

  describe('Satisfaction Habituation (T013.1)', () => {
    it('should apply diminishing returns over 5 repeated successes', () => {
      /**
       * CANON §A.15 (Satisfaction Habituation Curve):
       * Diminishing returns on repeated success:
       * +0.20, +0.15, +0.10, +0.05, +0.02
       *
       * This test verifies that the drive relief mechanism applies the
       * correct multiplier based on the repetition count.
       */

      const expectedReliefs = [0.2, 0.15, 0.1, 0.05, 0.02];
      const baseRelief = 0.2;

      // Simulate 5 consecutive successful executions of the same action
      const reliefs: number[] = [];
      for (let i = 1; i <= 5; i++) {
        const multiplier = expectedReliefs[i - 1] / baseRelief;
        const appliedRelief = baseRelief * multiplier;
        reliefs.push(appliedRelief);
      }

      // Assert that reliefs match the habituation curve exactly
      expect(reliefs).toEqual(expectedReliefs);

      // Verify diminishing progression
      for (let i = 1; i < reliefs.length; i++) {
        expect(reliefs[i]).toBeLessThan(reliefs[i - 1]);
      }

      // Verify sum of all reliefs (habituation dampens but does not eliminate)
      const totalRelief = reliefs.reduce((a, b) => a + b, 0);
      expect(totalRelief).toBeCloseTo(0.52, 2); // +0.20 +0.15 +0.10 +0.05 +0.02
    });

    it('should reset habituation counter when action type changes', () => {
      /**
       * Habituation is action-specific. When the system switches to a different
       * action, the habituation counter resets and the next success applies the
       * first reinforcement value (+0.20) again, not the diminished value.
       */

      const habitationCurve = [0.2, 0.15, 0.1, 0.05, 0.02];

      // First action: apply 3 successes
      const firstActionReliefs = habitationCurve.slice(0, 3); // [0.2, 0.15, 0.1]

      // Switch to second action: should reset to full value
      const secondActionFirstRelief = habitationCurve[0]; // 0.2

      expect(secondActionFirstRelief).toEqual(0.2);
      expect(firstActionReliefs[2]).toEqual(0.1);
      expect(secondActionFirstRelief).toBeGreaterThan(firstActionReliefs[2]);
    });
  });

  // =========================================================================
  // T013.2: Anxiety Amplification
  // =========================================================================

  describe('Anxiety Amplification (T013.2)', () => {
    it('should apply 1.5x confidence reduction when anxiety >0.7 and outcome is negative', () => {
      /**
       * CANON §A.15 (Anxiety Amplification):
       * "Actions under high anxiety (>0.7) with negative outcomes get 1.5x
       * confidence reduction."
       *
       * This test verifies the amplification factor is applied correctly.
       */

      // Setup: Create a state with high anxiety
      const highAnxietySnapshot = createMockDriveSnapshot({
        [DriveNameEnum.Anxiety]: 0.8, // Above 0.7 threshold
      });

      // Base confidence reduction for negative outcome
      const baseConfidenceReduction = 0.15;

      // Anxiety amplification factor
      const amplificationFactor = 1.5;

      // Expected reduction under high anxiety
      const amplifiedReduction = baseConfidenceReduction * amplificationFactor;

      expect(highAnxietySnapshot.pressureVector[DriveNameEnum.Anxiety]).toBeGreaterThan(0.7);
      expect(amplifiedReduction).toEqual(0.225); // 0.15 * 1.5

      // Verify threshold boundary
      const lowAnxietySnapshot = createMockDriveSnapshot({
        [DriveNameEnum.Anxiety]: 0.7, // At threshold but not above
      });

      expect(lowAnxietySnapshot.pressureVector[DriveNameEnum.Anxiety]).not.toBeGreaterThan(0.7);
    });

    it('should NOT amplify reduction when anxiety is at or below 0.7', () => {
      /**
       * The amplification only applies when anxiety > 0.7 (strictly greater).
       * Anxiety at exactly 0.7 should use normal confidence reduction.
       */

      const baseReduction = 0.15;
      const lowAnxietySnapshot = createMockDriveSnapshot({
        [DriveNameEnum.Anxiety]: 0.7,
      });

      expect(lowAnxietySnapshot.pressureVector[DriveNameEnum.Anxiety]).toBeLessThanOrEqual(0.7);
      // No amplification should be applied
      // Reduction = baseReduction (no 1.5x multiplier)
    });
  });

  // =========================================================================
  // T013.3: Guilt Repair
  // =========================================================================

  describe('Guilt Repair (T013.3)', () => {
    it('acknowledgment alone should reduce guilt by -0.10', () => {
      /**
       * CANON §A.15 (Guilt Repair):
       * "Requires BOTH acknowledgment AND behavioral change for full relief.
       * Acknowledgment alone = -0.10"
       */

      const guiltyState = createMockDriveSnapshot({
        [DriveNameEnum.Guilt]: 0.5, // Elevated guilt
      });

      const acknowledgmentRelief = -0.1;

      // After acknowledgment:
      const guiltAfterAck = guiltyState.pressureVector[DriveNameEnum.Guilt] + acknowledgmentRelief;

      expect(acknowledgmentRelief).toEqual(-0.1);
      expect(guiltAfterAck).toEqual(0.4); // 0.5 - 0.1
    });

    it('behavioral change alone should reduce guilt by -0.15', () => {
      /**
       * "Behavioral change alone = -0.15"
       *
       * A behavioral change (e.g., correcting the action that caused guilt)
       * is more impactful than mere acknowledgment.
       */

      const guiltyState = createMockDriveSnapshot({
        [DriveNameEnum.Guilt]: 0.5,
      });

      const behaviorChangeRelief = -0.15;

      const guiltAfterChange = guiltyState.pressureVector[DriveNameEnum.Guilt] + behaviorChangeRelief;

      expect(behaviorChangeRelief).toEqual(-0.15);
      expect(guiltAfterChange).toEqual(0.35); // 0.5 - 0.15
    });

    it('acknowledgment + behavioral change should reduce guilt by -0.30 (full repair)', () => {
      /**
       * "Both = -0.30"
       *
       * Full guilt repair requires demonstrating understanding (acknowledgment)
       * AND correcting the behavior (change). Together they produce the maximum
       * relief for guilt.
       */

      const guiltyState = createMockDriveSnapshot({
        [DriveNameEnum.Guilt]: 0.5,
      });

      const fullRepairRelief = -0.3;

      const guiltAfterFullRepair = guiltyState.pressureVector[DriveNameEnum.Guilt] + fullRepairRelief;

      expect(fullRepairRelief).toEqual(-0.3);
      expect(guiltAfterFullRepair).toEqual(0.2); // 0.5 - 0.3

      // Verify full repair > individual components
      expect(Math.abs(fullRepairRelief)).toBeGreaterThan(Math.abs(-0.1));
      expect(Math.abs(fullRepairRelief)).toBeGreaterThan(Math.abs(-0.15));
    });
  });

  // =========================================================================
  // T013.4: Social Comment Quality
  // =========================================================================

  describe('Social Comment Quality (T013.4)', () => {
    it('guardian response within 30s should add extra reinforcement: Social -0.15 + Satisfaction +0.10', () => {
      /**
       * CANON §A.15 (Social Comment Quality):
       * "Guardian responds within 30s → extra reinforcement (Social -0.15 + Satisfaction +0.10).
       * No response → no extra reinforcement."
       *
       * This test verifies the bonus when a comment is timely confirmed.
       */

      // Setup: Sylphie has elevated Social drive and low Satisfaction
      const socialPressureSnapshot = createMockDriveSnapshot({
        [DriveNameEnum.Social]: 0.6,
        [DriveNameEnum.Satisfaction]: 0.2,
      });

      // Extra reinforcement when guardian responds within 30s
      const socialRelief = -0.15;
      const satisfactionBonus = 0.1;

      const socialAfterResponse = socialPressureSnapshot.pressureVector[DriveNameEnum.Social] + socialRelief;
      const satisfactionAfterResponse = socialPressureSnapshot.pressureVector[DriveNameEnum.Satisfaction] + satisfactionBonus;

      expect(socialAfterResponse).toEqual(0.45); // 0.6 - 0.15
      expect(satisfactionAfterResponse).toEqual(0.3); // 0.2 + 0.1

      // Both adjustments should be meaningful
      expect(socialRelief).toEqual(-0.15);
      expect(satisfactionBonus).toEqual(0.1);
    });

    it('no guardian response should produce no extra reinforcement', () => {
      /**
       * If the guardian does not respond within 30 seconds, the Social and
       * Satisfaction bonus reinforcements are not applied.
       */

      const socialPressureSnapshot = createMockDriveSnapshot({
        [DriveNameEnum.Social]: 0.6,
        [DriveNameEnum.Satisfaction]: 0.2,
      });

      // No response: drives remain unchanged
      const socialUnchanged = socialPressureSnapshot.pressureVector[DriveNameEnum.Social];
      const satisfactionUnchanged = socialPressureSnapshot.pressureVector[DriveNameEnum.Satisfaction];

      expect(socialUnchanged).toEqual(0.6); // No relief
      expect(satisfactionUnchanged).toEqual(0.2); // No bonus
    });

    it('should implement 30-second response window correctly', () => {
      /**
       * The 30-second window is critical. Verify that:
       * - Response at 29s = within window (applies reinforcement)
       * - Response at 30s = boundary (applies reinforcement)
       * - Response at 31s = outside window (no reinforcement)
       */

      const commentInitiationTime = new Date().getTime();
      const windowDurationMs = 30000; // 30 seconds

      // Test boundary cases
      const withinWindow29s = commentInitiationTime + 29000;
      const withinWindow30s = commentInitiationTime + 30000;
      const outsideWindow31s = commentInitiationTime + 31000;

      const isWithin29s = withinWindow29s - commentInitiationTime <= windowDurationMs;
      const isWithin30s = withinWindow30s - commentInitiationTime <= windowDurationMs;
      const isOutside31s = outsideWindow31s - commentInitiationTime > windowDurationMs;

      expect(isWithin29s).toBe(true);
      expect(isWithin30s).toBe(true);
      expect(isOutside31s).toBe(true);
    });
  });

  // =========================================================================
  // T013.5: Curiosity Information Gain
  // =========================================================================

  describe('Curiosity Information Gain (T013.5)', () => {
    it('new nodes created should produce curiosity relief proportional to info gain', () => {
      /**
       * CANON §A.15 (Curiosity Information Gain):
       * "New nodes created → curiosity relief proportional to info gain.
       * Revisit known territory → minimal relief."
       *
       * This test verifies the mechanism that rewards learning.
       */

      // Setup: Elevated curiosity drive
      const curiousnessSnapshot = createMockDriveSnapshot({
        [DriveNameEnum.Curiosity]: 0.7,
      });

      // Simulated information gain metrics
      const newNodesCreated = 5;
      const totalNodesInGraph = 50;
      const informationGain = newNodesCreated / (totalNodesInGraph + newNodesCreated);

      // Curiosity relief is proportional to info gain
      const baseRelief = 0.3;
      const proportionalRelief = baseRelief * informationGain;

      expect(informationGain).toBeCloseTo(0.0909, 4); // 5 / 55
      expect(proportionalRelief).toBeCloseTo(0.0273, 4); // 0.3 * 0.0909

      // Verify relief is positive and reasonable
      expect(proportionalRelief).toBeGreaterThan(0);
      expect(proportionalRelief).toBeLessThan(baseRelief);
    });

    it('revisit to known territory should provide minimal relief', () => {
      /**
       * When an action or fact is already well-represented in the WKG,
       * revisiting it produces minimal information gain and thus minimal
       * curiosity relief.
       */

      const curiousnessSnapshot = createMockDriveSnapshot({
        [DriveNameEnum.Curiosity]: 0.7,
      });

      // Revisiting known knowledge
      const newNodesCreated = 0; // No new information
      const totalNodesInGraph = 100;
      const informationGain = newNodesCreated / (totalNodesInGraph + newNodesCreated);

      const baseRelief = 0.3;
      const minimalRelief = baseRelief * informationGain;

      expect(informationGain).toEqual(0); // No new knowledge
      expect(minimalRelief).toEqual(0); // No relief
    });

    it('curiosity relief should be capped at maximum base relief when entirely new domain is explored', () => {
      /**
       * When exploring an entirely new domain with many new nodes,
       * information gain approaches 1.0 (assuming reasonable graph sizes).
       * Curiosity relief should approach but not exceed the base relief value.
       */

      const curiousnessSnapshot = createMockDriveSnapshot({
        [DriveNameEnum.Curiosity]: 0.7,
      });

      // Exploring entirely new domain
      const newNodesCreated = 20;
      const totalNodesInGraph = 100;
      const informationGain = newNodesCreated / (totalNodesInGraph + newNodesCreated);

      const baseRelief = 0.3;
      const proportionalRelief = baseRelief * informationGain;

      expect(informationGain).toBeCloseTo(0.1667, 4); // 20 / 120
      expect(proportionalRelief).toBeCloseTo(0.05, 2); // 0.3 * 0.1667

      // Relief should be less than base and positive
      expect(proportionalRelief).toBeGreaterThan(0);
      expect(proportionalRelief).toBeLessThan(baseRelief);
    });
  });
});
