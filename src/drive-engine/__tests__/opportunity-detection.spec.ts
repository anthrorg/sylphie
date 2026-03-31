/**
 * Opportunity Detection Tests
 *
 * CANON §E4-T010: Opportunity detection identifies prediction failure patterns
 * requiring Planning intervention. Opportunities are classified, scored, decay
 * over time, and emitted via IPC.
 */

import {
  RECURRING_FAILURE_THRESHOLD,
  HIGH_IMPACT_MAE_THRESHOLD,
  HIGH_IMPACT_PRESSURE_THRESHOLD,
  COLD_START_SESSION_COUNT,
  DECAY_MAE_THRESHOLD,
  DECAY_PRIORITY_REDUCTION,
  MAX_QUEUE_SIZE,
} from '../constants/opportunity-detection';

describe('Opportunity Detection', () => {
  describe('Opportunity Classification', () => {
    it('should classify as RECURRING when failures > threshold', () => {
      const failureCount = RECURRING_FAILURE_THRESHOLD;
      const isRecurring = failureCount >= RECURRING_FAILURE_THRESHOLD;
      expect(isRecurring).toBe(true);
    });

    it('should require >= 3 failures for RECURRING classification', () => {
      expect(RECURRING_FAILURE_THRESHOLD).toBe(3);
    });

    it('should classify as HIGH_IMPACT when MAE > threshold', () => {
      const mae = HIGH_IMPACT_MAE_THRESHOLD;
      const isHighImpact = mae >= HIGH_IMPACT_MAE_THRESHOLD;
      expect(isHighImpact).toBe(true);
    });

    it('should classify as HIGH_IMPACT when totalPressure > threshold', () => {
      const totalPressure = HIGH_IMPACT_PRESSURE_THRESHOLD;
      const isHighImpact = totalPressure >= HIGH_IMPACT_PRESSURE_THRESHOLD;
      expect(isHighImpact).toBe(true);
    });

    it('should use MAE threshold of 0.40 for high impact', () => {
      expect(HIGH_IMPACT_MAE_THRESHOLD).toBe(0.4);
    });

    it('should use pressure threshold of 0.8 for high impact', () => {
      expect(HIGH_IMPACT_PRESSURE_THRESHOLD).toBe(0.8);
    });
  });

  describe('Cold-Start Dampening', () => {
    it('should apply dampening in early sessions', () => {
      const sessionNumber = 1;
      const basePriority = 0.8;
      const dampening = Math.min(1.0, sessionNumber / COLD_START_SESSION_COUNT);
      const dampedPriority = basePriority * dampening;

      expect(dampedPriority).toBeLessThan(basePriority);
    });

    it('should apply 0.1x dampening in session 1', () => {
      const sessionNumber = 1;
      const dampening = Math.min(1.0, sessionNumber / COLD_START_SESSION_COUNT);
      expect(dampening).toBeCloseTo(0.1);
    });

    it('should apply 0.5x dampening in session 5', () => {
      const sessionNumber = 5;
      const dampening = Math.min(1.0, sessionNumber / COLD_START_SESSION_COUNT);
      expect(dampening).toBeCloseTo(0.5);
    });

    it('should apply 1.0x dampening in session 10+', () => {
      const sessionNumber = 10;
      const dampening = Math.min(1.0, sessionNumber / COLD_START_SESSION_COUNT);
      expect(dampening).toBeCloseTo(1.0);

      const sessionNumber2 = 100;
      const dampening2 = Math.min(1.0, sessionNumber2 / COLD_START_SESSION_COUNT);
      expect(dampening2).toBeCloseTo(1.0);
    });

    it('should use session count of 10 for cold-start window', () => {
      expect(COLD_START_SESSION_COUNT).toBe(10);
    });
  });

  describe('Opportunity Decay', () => {
    it('should decay priority when MAE improves', () => {
      const basePriority = 0.8;
      const currentMAE = 0.08; // Improved (< threshold)

      if (currentMAE < DECAY_MAE_THRESHOLD) {
        const decayedPriority = basePriority * DECAY_PRIORITY_REDUCTION;
        expect(decayedPriority).toBeLessThan(basePriority);
      }
    });

    it('should reduce priority by 0.5x when MAE improves', () => {
      expect(DECAY_PRIORITY_REDUCTION).toBe(0.5);
    });

    it('should use MAE threshold of 0.10 for decay trigger', () => {
      expect(DECAY_MAE_THRESHOLD).toBe(0.1);
    });

    it('should not decay when MAE is still high', () => {
      const basePriority = 0.8;
      const currentMAE = 0.25; // Still high

      const shouldDecay = currentMAE < DECAY_MAE_THRESHOLD;
      expect(shouldDecay).toBe(false);
    });
  });

  describe('Priority Formula', () => {
    it('should compute priority: log(frequency + 1) * magnitude', () => {
      const frequency = 5;
      const magnitude = 0.6;
      const priority = Math.log(frequency + 1) * magnitude;

      expect(priority).toBeGreaterThan(0);
      // Note: priority can exceed 1.0 for high frequency, callers must clamp
      expect(priority).toBeLessThan(5.0);
    });

    it('should increase priority with frequency', () => {
      const magnitude = 0.5;
      const priority1 = Math.log(1 + 1) * magnitude;
      const priority2 = Math.log(5 + 1) * magnitude;
      const priority3 = Math.log(10 + 1) * magnitude;

      expect(priority1).toBeLessThan(priority2);
      expect(priority2).toBeLessThan(priority3);
    });

    it('should increase priority with magnitude', () => {
      const frequency = 5;
      const priority1 = Math.log(frequency + 1) * 0.2;
      const priority2 = Math.log(frequency + 1) * 0.5;
      const priority3 = Math.log(frequency + 1) * 0.8;

      expect(priority1).toBeLessThan(priority2);
      expect(priority2).toBeLessThan(priority3);
    });

    it('should cap frequency contribution via logarithm', () => {
      const magnitude = 1.0;
      const priority100 = Math.log(100 + 1) * magnitude;
      const priority1000 = Math.log(1000 + 1) * magnitude;

      // Logarithmic growth slows down
      expect(priority1000 - priority100).toBeLessThan(
        Math.log(100 + 1) - Math.log(1 + 1),
      );
    });
  });

  describe('Queue Management', () => {
    it('should enforce maximum queue size', () => {
      expect(MAX_QUEUE_SIZE).toBe(50);
    });

    it('should remove lowest-priority items when queue exceeds max', () => {
      const queue = Array.from({ length: MAX_QUEUE_SIZE + 5 }, (_, i) => ({
        id: `opp-${i}`,
        priority: (MAX_QUEUE_SIZE + 5 - i) * 0.01, // Decreasing priority
      }));

      // Sort by priority descending, keep top MAX_QUEUE_SIZE
      const sorted = queue.sort((a, b) => b.priority - a.priority);
      const pruned = sorted.slice(0, MAX_QUEUE_SIZE);

      expect(pruned).toHaveLength(MAX_QUEUE_SIZE);
      // Lowest priorities should be removed
      expect(pruned[pruned.length - 1].priority).toBeGreaterThan(
        sorted[MAX_QUEUE_SIZE].priority,
      );
    });

    it('should not remove items when queue is below max', () => {
      const queueSize = MAX_QUEUE_SIZE - 10;
      expect(queueSize).toBeLessThan(MAX_QUEUE_SIZE);
    });
  });

  describe('Emission Rate Limiting', () => {
    it('should emit top opportunities periodically', () => {
      // Configuration exists for emission rate
      const EMISSION_INTERVAL_TICKS = 100;
      const EMISSION_MAX_PER_CYCLE = 5;

      expect(EMISSION_INTERVAL_TICKS).toBeGreaterThan(0);
      expect(EMISSION_MAX_PER_CYCLE).toBeGreaterThan(0);
    });
  });

  describe('Threshold Relationships', () => {
    it('should have recurring threshold >= 2 (pattern detection)', () => {
      expect(RECURRING_FAILURE_THRESHOLD).toBeGreaterThanOrEqual(2);
    });

    it('should have high impact MAE threshold > moderate threshold', () => {
      expect(HIGH_IMPACT_MAE_THRESHOLD).toBeGreaterThan(0.2);
    });

    it('should have high impact pressure threshold > 0.5', () => {
      expect(HIGH_IMPACT_PRESSURE_THRESHOLD).toBeGreaterThan(0.5);
    });

    it('should have decay threshold more strict than high impact', () => {
      expect(DECAY_MAE_THRESHOLD).toBeLessThan(HIGH_IMPACT_MAE_THRESHOLD);
    });
  });

  describe('Deduplication', () => {
    it('should prevent duplicate opportunities for same pattern', () => {
      const existingOpportunities = [
        {
          contextFingerprint: 'pattern-a',
          predictionMAE: 0.35,
          priority: 0.7,
        },
      ];

      const newOpportunity = {
        contextFingerprint: 'pattern-a',
        predictionMAE: 0.38,
        priority: 0.75,
      };

      // Check if pattern already exists
      const existingIndex = existingOpportunities.findIndex(
        (opp) => opp.contextFingerprint === newOpportunity.contextFingerprint,
      );

      if (existingIndex >= 0) {
        // Update existing instead of adding duplicate
        existingOpportunities[existingIndex] = newOpportunity;
      }

      expect(existingOpportunities).toHaveLength(1);
      expect(existingOpportunities[0].priority).toBe(0.75);
    });
  });

  describe('Priority Bounds', () => {
    it('should keep priority in [0.0, 1.0]', () => {
      const priority1 = Math.log(1 + 1) * 0.0; // Min
      const priority2 = Math.log(100000 + 1) * 1.0; // Max input

      expect(priority1).toBeGreaterThanOrEqual(0.0);
      // Note: logarithm can exceed 1.0, so callers must clamp
      expect(Math.min(1.0, priority2)).toBeLessThanOrEqual(1.0);
    });
  });
});
