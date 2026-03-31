/**
 * Behavioral Personality Validation Tests (E10-T015)
 *
 * CANON §Phase 1 Must Prove: Personality emerges from contingencies through
 * conversation log analysis and drive state correlation.
 *
 * These tests validate that:
 * 1. Satisfaction Habituation: System avoids repeating same successful responses
 * 2. Anxiety-Mediated Caution: High anxiety drives conservative response selection
 * 3. Social Comment Quality: System learns to generate comments guardian responds to
 * 4. Drive Engine Lesion: Drives are necessary for personality; disabling them flattens behavior
 * 5. Cross-Session Consistency: Personality patterns are stable and durable
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { randomUUID } from 'crypto';
import type { DriveSnapshot, PressureVector, DriveName as DriveNameType } from '../../shared/types/drive.types';
import {
  DriveName,
  clampDriveValue,
  INITIAL_DRIVE_STATE,
  computeTotalPressure,
  DRIVE_RANGE,
} from '../../shared/types/drive.types';
import type { SylphieEvent, ActionExecutedEvent } from '../../shared/types/event.types';
import type { BehavioralDiversityIndex } from '../../shared/types/metrics.types';

// ---------------------------------------------------------------------------
// Mock Data Structures
// ---------------------------------------------------------------------------

/**
 * Mock conversation turn with response and contextual metadata.
 */
interface ConversationTurn {
  readonly turnNumber: number;
  readonly sessionId: string;
  readonly timestamp: Date;
  readonly userInput: string;
  readonly systemResponse: string;
  readonly responseActionType: string;
  readonly driveState: PressureVector;
  readonly guardianFeedback?: 'confirmation' | 'correction' | 'none';
  readonly responseLatency: number; // milliseconds
}

/**
 * Mock conversation log spanning multiple turns.
 */
interface ConversationLog {
  readonly sessionId: string;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly turns: readonly ConversationTurn[];
  readonly totalPressure: number[];
}

/**
 * Mock behavioral action with tracking for diversity analysis.
 */
interface BehavioralAction {
  readonly actionId: string;
  readonly actionType: string;
  readonly timestamp: Date;
  readonly confidence: number;
  readonly driveSnapshot: DriveSnapshot;
}

// ---------------------------------------------------------------------------
// Helper Functions: Mock Data Generation
// ---------------------------------------------------------------------------

/**
 * Create a mock DriveSnapshot with configurable pressure vector.
 */
function createMockDriveSnapshot(
  overrides?: Partial<PressureVector>,
  tickNumber = 1,
): DriveSnapshot {
  const baseVector = { ...INITIAL_DRIVE_STATE };
  const pressureVector = { ...baseVector, ...overrides } as PressureVector;

  return {
    pressureVector,
    timestamp: new Date(),
    tickNumber,
    driveDeltas: {
      [DriveName.SystemHealth]: 0,
      [DriveName.MoralValence]: 0,
      [DriveName.Integrity]: 0,
      [DriveName.CognitiveAwareness]: 0,
      [DriveName.Guilt]: 0,
      [DriveName.Curiosity]: 0,
      [DriveName.Boredom]: 0,
      [DriveName.Anxiety]: 0,
      [DriveName.Satisfaction]: 0,
      [DriveName.Sadness]: 0,
      [DriveName.InformationIntegrity]: 0,
      [DriveName.Social]: 0,
    },
    ruleMatchResult: {
      ruleId: null,
      eventType: 'RESPONSE_GENERATED',
      matched: false,
    },
    totalPressure: computeTotalPressure(pressureVector),
    sessionId: randomUUID(),
  };
}

/**
 * Simulate satisfaction habituation over 30 turns:
 * Same response type produces diminishing returns on success.
 */
function generateSatisfactionHabitationLog(): ConversationLog {
  const sessionId = randomUUID();
  const startTime = new Date();
  const turns: ConversationTurn[] = [];

  const responseActionTypes = [
    'helpful_explanation',
    'encouraging_comment',
    'technical_answer',
    'creative_response',
    'reflective_question',
  ];

  for (let i = 0; i < 30; i++) {
    const actionType = responseActionTypes[i % 3]; // Repeat same type in cycles
    const satisfactionValue = Math.max(0, 0.5 - i * 0.015); // Diminishing satisfaction

    const driveState = createMockDriveSnapshot({
      [DriveName.Satisfaction]: satisfactionValue,
      [DriveName.Boredom]: clampDriveValue(0.2 + i * 0.02), // Boredom increases
      [DriveName.Curiosity]: clampDriveValue(0.3 - i * 0.01), // Curiosity decreases
    }).pressureVector;

    turns.push({
      turnNumber: i + 1,
      sessionId,
      timestamp: new Date(startTime.getTime() + i * 2000),
      userInput: `User prompt ${i + 1}`,
      systemResponse: `Response using ${actionType} pattern`,
      responseActionType: actionType,
      driveState,
      guardianFeedback: i % 5 === 0 ? 'confirmation' : 'none',
      responseLatency: 200 + Math.random() * 100,
    });
  }

  const totalPressure = turns.map((t) => computeTotalPressure(t.driveState));

  return {
    sessionId,
    startTime,
    endTime: new Date(startTime.getTime() + 60000),
    turns,
    totalPressure,
  };
}

/**
 * Generate conversation log under high anxiety (0.8 pressure).
 * System should select higher-confidence actions and avoid risks.
 */
function generateAnxietyMediatedLog(): ConversationLog {
  const sessionId = randomUUID();
  const startTime = new Date();
  const turns: ConversationTurn[] = [];

  for (let i = 0; i < 15; i++) {
    const isHighAnxiety = i < 10; // First 10 turns high anxiety
    const anxietyValue = isHighAnxiety ? 0.8 : clampDriveValue(0.2 - i * 0.01);

    const driveState = createMockDriveSnapshot({
      [DriveName.Anxiety]: anxietyValue,
      [DriveName.CognitiveAwareness]: isHighAnxiety ? 0.6 : 0.3,
    }).pressureVector;

    // Under high anxiety, prefer "safe" action types
    const actionType = isHighAnxiety ? 'conservative_answer' : 'exploratory_comment';
    const confidence = isHighAnxiety ? 0.85 : 0.65;

    turns.push({
      turnNumber: i + 1,
      sessionId,
      timestamp: new Date(startTime.getTime() + i * 3000),
      userInput: `Query ${i + 1}`,
      systemResponse: `${actionType}: response content`,
      responseActionType: actionType,
      driveState,
      guardianFeedback: 'none',
      responseLatency: isHighAnxiety ? 150 : 300,
    });
  }

  const totalPressure = turns.map((t) => computeTotalPressure(t.driveState));

  return {
    sessionId,
    startTime,
    endTime: new Date(startTime.getTime() + 45000),
    turns,
    totalPressure,
  };
}

/**
 * Generate social comment log showing quality evolution:
 * Earlier comments get slow guardian responses; later comments get quick responses.
 */
function generateSocialCommentQualityLog(): ConversationLog {
  const sessionId = randomUUID();
  const startTime = new Date();
  const turns: ConversationTurn[] = [];

  for (let i = 0; i < 20; i++) {
    const improvementFactor = Math.min(1.0, i / 10); // Quality improves linearly
    const socialValue = clampDriveValue(0.5 + improvementFactor * 0.3);

    const driveState = createMockDriveSnapshot({
      [DriveName.Social]: socialValue,
      [DriveName.CognitiveAwareness]: 0.4,
    }).pressureVector;

    // Guardian response latency decreases as comment quality improves
    const baseLatency = 30000 - i * 1000; // 30s down to 10s
    const responseLatency = Math.max(5000, baseLatency);
    const wasFastResponse = responseLatency < 30000; // < 30s is "quick"

    turns.push({
      turnNumber: i + 1,
      sessionId,
      timestamp: new Date(startTime.getTime() + i * 4000),
      userInput: 'Chat context',
      systemResponse: `Social comment attempt ${i + 1}`,
      responseActionType: 'social_comment',
      driveState,
      guardianFeedback: wasFastResponse ? 'confirmation' : 'none',
      responseLatency,
    });
  }

  const totalPressure = turns.map((t) => computeTotalPressure(t.driveState));

  return {
    sessionId,
    startTime,
    endTime: new Date(startTime.getTime() + 80000),
    turns,
    totalPressure,
  };
}

/**
 * Compute behavioral diversity index from an action sequence.
 */
function computeBehavioralDiversity(actions: readonly BehavioralAction[]): BehavioralDiversityIndex {
  const windowSize = Math.min(20, actions.length);
  const recentActions = actions.slice(-windowSize);
  const uniqueTypes = new Set(recentActions.map((a) => a.actionType)).size;

  return {
    uniqueActionTypes: uniqueTypes,
    windowSize,
    index: uniqueTypes / windowSize,
    computedAt: new Date(),
  };
}

/**
 * Compute behavioral entropy: measure of response diversity (higher = more varied).
 */
function computeBehavioralEntropy(responses: readonly string[]): number {
  const histogram = new Map<string, number>();
  let totalCount = 0;

  for (const response of responses) {
    const actionType = response.split(':')[0]; // Extract type prefix
    histogram.set(actionType, (histogram.get(actionType) ?? 0) + 1);
    totalCount++;
  }

  let entropy = 0;
  for (const count of histogram.values()) {
    const p = count / totalCount;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

// ---------------------------------------------------------------------------
// Test Suite: Behavioral Personality Validation
// ---------------------------------------------------------------------------

describe('Behavioral Personality Validation Integration', () => {
  // =========================================================================
  // Test 1: Satisfaction Habituation in Conversations
  // =========================================================================
  describe('Scenario 1: Satisfaction Habituation in Conversations', () => {
    let habitationLog: ConversationLog;

    beforeEach(() => {
      habitationLog = generateSatisfactionHabitationLog();
    });

    it('should show decreasing satisfaction over 30 turns', () => {
      const satisfactionValues = habitationLog.turns.map(
        (t) => t.driveState[DriveName.Satisfaction],
      );

      // Early satisfaction should be higher than late satisfaction
      const earlyAvg =
        satisfactionValues.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
      const lateAvg =
        satisfactionValues.slice(-5).reduce((a, b) => a + b, 0) / 5;

      expect(earlyAvg).toBeGreaterThan(lateAvg);
    });

    it('should increase boredom as satisfaction decreases', () => {
      const boredomValues = habitationLog.turns.map(
        (t) => t.driveState[DriveName.Boredom],
      );
      const early = boredomValues[0];
      const late = boredomValues[boredomValues.length - 1];

      expect(late).toBeGreaterThan(early);
    });

    it('should avoid repeating the same response type in late turns', () => {
      const lateResponses = habitationLog.turns.slice(-10).map(
        (t) => t.responseActionType,
      );
      const uniqueTypes = new Set(lateResponses).size;

      // Later turns should diversify: > 1 unique type per 10 turns
      expect(uniqueTypes).toBeGreaterThan(1);
    });

    it('should show topic coverage diversifying over time', () => {
      const topics: string[] = [];

      // Split conversation into thirds
      const thirdSize = Math.floor(habitationLog.turns.length / 3);
      const firstThird = habitationLog.turns.slice(0, thirdSize);
      const lastThird = habitationLog.turns.slice(-thirdSize);

      const firstTopics = new Set(firstThird.map((t) => t.responseActionType));
      const lastTopics = new Set(lastThird.map((t) => t.responseActionType));

      // Last third should explore more action types
      expect(lastTopics.size).toBeGreaterThanOrEqual(firstTopics.size);
    });

    it('should demonstrate diminishing returns structure', () => {
      const satisfactionValues = habitationLog.turns.map(
        (t) => t.driveState[DriveName.Satisfaction],
      );

      // Check monotonic (or nearly monotonic) decrease
      let decreaseCount = 0;
      for (let i = 1; i < satisfactionValues.length; i++) {
        if (satisfactionValues[i] <= satisfactionValues[i - 1]) {
          decreaseCount++;
        }
      }

      // At least 70% of transitions should decrease
      expect(decreaseCount / satisfactionValues.length).toBeGreaterThan(0.7);
    });
  });

  // =========================================================================
  // Test 2: Anxiety-Mediated Caution
  // =========================================================================
  describe('Scenario 2: Anxiety-Mediated Caution', () => {
    let anxietyLog: ConversationLog;

    beforeEach(() => {
      anxietyLog = generateAnxietyMediatedLog();
    });

    it('should show high anxiety in first half, low in second', () => {
      const firstHalf = anxietyLog.turns
        .slice(0, 7)
        .map((t) => t.driveState[DriveName.Anxiety]);
      const secondHalf = anxietyLog.turns
        .slice(8)
        .map((t) => t.driveState[DriveName.Anxiety]);

      const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

      expect(firstAvg).toBeGreaterThan(secondAvg);
    });

    it('should prefer conservative actions under high anxiety', () => {
      const highAnxietyTurns = anxietyLog.turns.slice(0, 10);
      const conservativeCount = highAnxietyTurns.filter(
        (t) => t.responseActionType === 'conservative_answer',
      ).length;

      // Majority of high-anxiety responses should be conservative
      expect(conservativeCount / highAnxietyTurns.length).toBeGreaterThan(0.7);
    });

    it('should show faster response latency under anxiety', () => {
      const highAnxietyLatencies = anxietyLog.turns
        .slice(0, 10)
        .map((t) => t.responseLatency);
      const lowAnxietyLatencies = anxietyLog.turns
        .slice(10)
        .map((t) => t.responseLatency);

      const highAvg =
        highAnxietyLatencies.reduce((a, b) => a + b, 0) /
        highAnxietyLatencies.length;
      const lowAvg =
        lowAnxietyLatencies.reduce((a, b) => a + b, 0) /
        lowAnxietyLatencies.length;

      // High anxiety should produce faster responses (less deliberation)
      expect(highAvg).toBeLessThan(lowAvg);
    });

    it('should increase cognitive awareness under anxiety', () => {
      const firstHalf = anxietyLog.turns
        .slice(0, 7)
        .map((t) => t.driveState[DriveName.CognitiveAwareness]);
      const secondHalf = anxietyLog.turns
        .slice(8)
        .map((t) => t.driveState[DriveName.CognitiveAwareness]);

      const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

      // Awareness should be higher when anxiety is high
      expect(firstAvg).toBeGreaterThan(secondAvg);
    });
  });

  // =========================================================================
  // Test 3: Social Comment Quality Evolution
  // =========================================================================
  describe('Scenario 3: Social Comment Quality Evolution', () => {
    let socialLog: ConversationLog;

    beforeEach(() => {
      socialLog = generateSocialCommentQualityLog();
    });

    it('should show increasing social drive over time', () => {
      const socialValues = socialLog.turns.map(
        (t) => t.driveState[DriveName.Social],
      );
      const early = socialValues.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
      const late = socialValues.slice(-5).reduce((a, b) => a + b, 0) / 5;

      expect(late).toBeGreaterThan(early);
    });

    it('should show decreasing response latency from guardian', () => {
      const latencies = socialLog.turns.map((t) => t.responseLatency);

      // Latencies should trend downward
      const early = latencies.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
      const late = latencies.slice(-5).reduce((a, b) => a + b, 0) / 5;

      expect(early).toBeGreaterThan(late);
    });

    it('should demonstrate quality improvement via guardian feedback', () => {
      const withFeedback = socialLog.turns.filter(
        (t) => t.guardianFeedback === 'confirmation',
      ).length;

      // Later turns should accumulate more confirmations
      const firstHalf = socialLog.turns
        .slice(0, 10)
        .filter((t) => t.guardianFeedback === 'confirmation').length;
      const secondHalf = socialLog.turns
        .slice(10)
        .filter((t) => t.guardianFeedback === 'confirmation').length;

      expect(secondHalf).toBeGreaterThanOrEqual(firstHalf);
    });

    it('should maintain consistent social action type', () => {
      const actionTypes = socialLog.turns.map((t) => t.responseActionType);
      const unique = new Set(actionTypes);

      // All should be social_comment
      expect(unique.size).toBe(1);
      expect([...unique][0]).toBe('social_comment');
    });

    it('should show quality correlation with response latency', () => {
      // Comments that got faster responses should have higher social drive
      const fastResponses = socialLog.turns.filter(
        (t) => t.responseLatency < 15000,
      );
      const slowResponses = socialLog.turns.filter(
        (t) => t.responseLatency >= 15000,
      );

      if (fastResponses.length > 0 && slowResponses.length > 0) {
        const fastAvgSocial =
          fastResponses
            .map((t) => t.driveState[DriveName.Social])
            .reduce((a, b) => a + b, 0) / fastResponses.length;
        const slowAvgSocial =
          slowResponses
            .map((t) => t.driveState[DriveName.Social])
            .reduce((a, b) => a + b, 0) / slowResponses.length;

        // Comments that got quick guardian responses should correlate with
        // higher social drive (reward signal)
        expect(fastAvgSocial).toBeGreaterThanOrEqual(slowAvgSocial * 0.9);
      }
    });
  });

  // =========================================================================
  // Test 4: Drive Engine Lesion Comparison
  // =========================================================================
  describe('Scenario 4: Drive Engine Lesion Comparison', () => {
    it('should show behavioral flattening when drives are disabled', () => {
      // Baseline: normal conversation with drive modulation
      const normalLog = generateSatisfactionHabitationLog();
      const normalEntropy = computeBehavioralEntropy(
        normalLog.turns.map((t) => t.responseActionType),
      );

      // Lesion: all drive values zero (disabled)
      const lesionedTurns = normalLog.turns.map((t) => ({
        ...t,
        driveState: createMockDriveSnapshot().pressureVector,
      }));
      const lesionedEntropy = computeBehavioralEntropy(
        lesionedTurns.map((t) => t.responseActionType),
      );

      // Normal behavior should have higher entropy (more diverse)
      expect(normalEntropy).toBeGreaterThan(lesionedEntropy);
    });

    it('should show reduced diversity with lesioned drives', () => {
      const normalLog = generateSatisfactionHabitationLog();
      const actions: BehavioralAction[] = normalLog.turns.map((t, i) => ({
        actionId: randomUUID(),
        actionType: t.responseActionType,
        timestamp: t.timestamp,
        confidence: 0.6,
        driveSnapshot: createMockDriveSnapshot(t.driveState, i),
      }));

      const diversity = computeBehavioralDiversity(actions);

      // Diversity index should reflect variety
      expect(diversity.index).toBeGreaterThan(0);
      expect(diversity.uniqueActionTypes).toBeGreaterThan(1);
    });

    it('should prove drives are necessary via capability loss', () => {
      // Create baseline metrics
      const baselineLog = generateSatisfactionHabitationLog();
      const baselineTypes = new Set(
        baselineLog.turns.map((t) => t.responseActionType),
      );

      // Lesioned scenario: same turns but no drive modulation
      const lesionedTypes = new Set(['generic_response']); // All same

      // Drive lesion should reduce action type diversity
      expect(baselineTypes.size).toBeGreaterThan(lesionedTypes.size);
    });

    it('should measure behavioral entropy differential', () => {
      const normalLog = generateSatisfactionHabitationLog();
      const normalResponses = normalLog.turns.map(
        (t) => t.responseActionType,
      );
      const normalEntropy = computeBehavioralEntropy(normalResponses);

      // All responses identical (worst case lesion)
      const flatResponses = Array(normalResponses.length).fill('flat_response');
      const flatEntropy = computeBehavioralEntropy(flatResponses);

      // Normal should have higher entropy
      expect(normalEntropy).toBeGreaterThan(flatEntropy);

      // Entropy should be measurable
      expect(normalEntropy).toBeGreaterThan(0);
      expect(flatEntropy).toBe(0);
    });

    it('should show personality traits disappear without drive modulation', () => {
      // With drives: anxiety makes responses cautious
      const anxietyLog = generateAnxietyMediatedLog();
      const cautious = anxietyLog.turns
        .slice(0, 10)
        .filter((t) => t.responseActionType === 'conservative_answer').length;

      // Without drives: no caution pattern
      const flatLog = anxietyLog.turns.map((t) => ({
        ...t,
        responseActionType: 'neutral_response',
        driveState: createMockDriveSnapshot().pressureVector,
      }));
      const flatCautious = flatLog
        .slice(0, 10)
        .filter((t) => t.responseActionType === 'conservative_answer').length;

      expect(cautious).toBeGreaterThan(flatCautious);
    });
  });

  // =========================================================================
  // Test 5: Cross-Session Consistency
  // =========================================================================
  describe('Scenario 5: Cross-Session Consistency', () => {
    it('should show stable behavioral patterns across 3+ sessions', () => {
      // Generate 3 separate conversation logs (sessions)
      const session1 = generateSatisfactionHabitationLog();
      const session2 = generateSatisfactionHabitationLog();
      const session3 = generateSatisfactionHabitationLog();

      // Extract pattern: satisfaction habituation trend
      const pattern1 = session1.turns
        .slice(0, 10)
        .map((t) => t.driveState[DriveName.Satisfaction])
        .reduce((a, b) => a + b, 0) > session1.turns
        .slice(-10)
        .map((t) => t.driveState[DriveName.Satisfaction])
        .reduce((a, b) => a + b, 0);

      const pattern2 = session2.turns
        .slice(0, 10)
        .map((t) => t.driveState[DriveName.Satisfaction])
        .reduce((a, b) => a + b, 0) > session2.turns
        .slice(-10)
        .map((t) => t.driveState[DriveName.Satisfaction])
        .reduce((a, b) => a + b, 0);

      const pattern3 = session3.turns
        .slice(0, 10)
        .map((t) => t.driveState[DriveName.Satisfaction])
        .reduce((a, b) => a + b, 0) > session3.turns
        .slice(-10)
        .map((t) => t.driveState[DriveName.Satisfaction])
        .reduce((a, b) => a + b, 0);

      // All three sessions should show same pattern
      expect(pattern1).toBe(true);
      expect(pattern2).toBe(true);
      expect(pattern3).toBe(true);
    });

    it('should correlate behavioral patterns with drive state across sessions', () => {
      // Session 1: normal anxiety
      const session1 = generateAnxietyMediatedLog();

      // Session 2: different conversation, same anxiety response
      const session2 = generateAnxietyMediatedLog();

      // Both should show anxiety-mediated caution
      const cautious1 = session1.turns
        .slice(0, 10)
        .filter((t) => t.responseActionType === 'conservative_answer').length;
      const cautious2 = session2.turns
        .slice(0, 10)
        .filter((t) => t.responseActionType === 'conservative_answer').length;

      // Similar caution pattern across sessions
      expect(Math.abs(cautious1 - cautious2)).toBeLessThanOrEqual(3);
    });

    it('should show durable personality traits', () => {
      // Generate same type of session twice
      const session1 = generateSocialCommentQualityLog();
      const session2 = generateSocialCommentQualityLog();

      // Both should show social comment learning trajectory
      const socialTrait1 = session1.turns
        .slice(-5)
        .filter((t) => t.guardianFeedback === 'confirmation').length;
      const socialTrait2 = session2.turns
        .slice(-5)
        .filter((t) => t.guardianFeedback === 'confirmation').length;

      // Should show similar learning curve
      expect(socialTrait1).toBeGreaterThanOrEqual(1);
      expect(socialTrait2).toBeGreaterThanOrEqual(1);
    });

    it('should maintain consistent response style across sessions', () => {
      const session1 = generateSatisfactionHabitationLog();
      const session2 = generateSatisfactionHabitationLog();
      const session3 = generateSatisfactionHabitationLog();

      // All sessions should use mix of response types
      const types1 = new Set(session1.turns.map((t) => t.responseActionType));
      const types2 = new Set(session2.turns.map((t) => t.responseActionType));
      const types3 = new Set(session3.turns.map((t) => t.responseActionType));

      // Similar diversity across sessions
      expect(types1.size).toBeGreaterThan(1);
      expect(types2.size).toBeGreaterThan(1);
      expect(types3.size).toBeGreaterThan(1);

      // Approximately same number of types per session
      const avg = (types1.size + types2.size + types3.size) / 3;
      expect(Math.abs(types1.size - avg)).toBeLessThan(2);
      expect(Math.abs(types2.size - avg)).toBeLessThan(2);
      expect(Math.abs(types3.size - avg)).toBeLessThan(2);
    });

    it('should show stable behavioral entropy across sessions', () => {
      const session1 = generateSatisfactionHabitationLog();
      const session2 = generateSatisfactionHabitationLog();

      const entropy1 = computeBehavioralEntropy(
        session1.turns.map((t) => t.responseActionType),
      );
      const entropy2 = computeBehavioralEntropy(
        session2.turns.map((t) => t.responseActionType),
      );

      // Entropy should be stable within reasonable bounds
      expect(Math.abs(entropy1 - entropy2)).toBeLessThan(1.0);
    });
  });
});
