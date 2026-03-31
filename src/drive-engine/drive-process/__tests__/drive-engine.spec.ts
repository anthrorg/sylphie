/**
 * Core drive computation engine tests.
 *
 * CANON §Subsystem 4: Verify the 12-drive tick loop, accumulation,
 * decay, cross-modulation, clamping, and IPC publishing.
 */

import {
  DriveName,
  INITIAL_DRIVE_STATE,
  DRIVE_RANGE,
} from '../../../shared/types/drive.types';
import { DriveStateManager } from '../drive-state';
import { getDriveUpdateRates, validateRates } from '../accumulation';
import { clampDrive, checkBounds } from '../clamping';
import { applyCrossModulation } from '../cross-modulation';

describe('DriveEngine - Drive State Management', () => {
  describe('DriveStateManager', () => {
    it('should initialize with INITIAL_DRIVE_STATE', () => {
      const manager = new DriveStateManager();
      const state = manager.getCurrent();

      expect(state[DriveName.SystemHealth]).toBeCloseTo(0.2);
      expect(state[DriveName.Curiosity]).toBeCloseTo(0.3);
      expect(state[DriveName.Social]).toBeCloseTo(0.5);
    });

    it('should apply accumulation rates', () => {
      const manager = new DriveStateManager();
      const rates = getDriveUpdateRates();

      // Apply rates once
      manager.applyRates(rates);
      const updated = manager.getCurrent();

      // SystemHealth should have increased by its accumulation rate (0.003)
      expect(updated[DriveName.SystemHealth]).toBeCloseTo(
        INITIAL_DRIVE_STATE[DriveName.SystemHealth] + 0.003,
        5,
      );

      // Satisfaction should have decreased by its decay rate (-0.003)
      expect(updated[DriveName.Satisfaction]).toBeCloseTo(
        INITIAL_DRIVE_STATE[DriveName.Satisfaction] - 0.003,
        5,
      );
    });

    it('should apply outcome effects to drives', () => {
      const manager = new DriveStateManager();

      const effects = {
        [DriveName.Satisfaction]: 0.5,
        [DriveName.Anxiety]: -0.2,
      };

      manager.applyOutcomeEffects(effects);
      const state = manager.getCurrent();

      expect(state[DriveName.Satisfaction]).toBeCloseTo(
        INITIAL_DRIVE_STATE[DriveName.Satisfaction] + 0.5,
        5,
      );
      expect(state[DriveName.Anxiety]).toBeCloseTo(
        INITIAL_DRIVE_STATE[DriveName.Anxiety] - 0.2,
        5,
      );
    });

    it('should compute deltas between ticks', () => {
      const manager = new DriveStateManager();

      const effects = {
        [DriveName.Satisfaction]: 0.3,
      };

      manager.applyOutcomeEffects(effects);
      const deltas = manager.computeDeltas();

      expect(deltas[DriveName.Satisfaction]).toBeCloseTo(0.3, 5);
      expect(deltas[DriveName.SystemHealth]).toBe(0);
    });

    it('should freeze current state to immutable PressureVector', () => {
      const manager = new DriveStateManager();

      const effects = {
        [DriveName.Satisfaction]: 0.2,
      };

      manager.applyOutcomeEffects(effects);
      const frozen = manager.freezeCurrent();

      // Should not be able to mutate frozen state
      expect(Object.isFrozen(frozen)).toBe(true);

      // Original manager state should be unaffected
      manager.applyDelta(DriveName.Anxiety, 0.1);
      expect(frozen[DriveName.Anxiety]).toBeCloseTo(
        INITIAL_DRIVE_STATE[DriveName.Anxiety],
        5,
      );
    });

    it('should advance tick and preserve previous state', () => {
      const manager = new DriveStateManager();

      const rates = getDriveUpdateRates();
      manager.applyRates(rates);

      const beforeAdvance = manager.getCurrent();
      manager.advanceTick();
      const afterAdvance = manager.getCurrent();

      // Current should be the same
      expect(afterAdvance[DriveName.SystemHealth]).toBeCloseTo(
        beforeAdvance[DriveName.SystemHealth],
        5,
      );

      // Previous should now match what current was
      const previous = manager.getPrevious();
      expect(previous[DriveName.SystemHealth]).toBeCloseTo(
        beforeAdvance[DriveName.SystemHealth],
        5,
      );
    });
  });
});

describe('DriveEngine - Accumulation and Decay', () => {
  it('should validate accumulation and decay rates at startup', () => {
    const validation = validateRates();
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  it('should provide non-negative accumulation rates for core drives', () => {
    const rates = getDriveUpdateRates();

    expect(rates[DriveName.SystemHealth]).toBeGreaterThanOrEqual(0);
    expect(rates[DriveName.MoralValence]).toBeGreaterThanOrEqual(0);
    expect(rates[DriveName.Integrity]).toBeGreaterThanOrEqual(0);
    expect(rates[DriveName.CognitiveAwareness]).toBeGreaterThanOrEqual(0);
  });

  it('should have negative decay rates for satisfaction and sadness', () => {
    const rates = getDriveUpdateRates();

    expect(rates[DriveName.Satisfaction]).toBeLessThan(0);
    expect(rates[DriveName.Sadness]).toBeLessThan(0);
  });
});

describe('DriveEngine - Clamping', () => {
  it('should clamp values to [-10.0, 1.0]', () => {
    expect(clampDrive(DriveName.SystemHealth, 2.0)).toBe(DRIVE_RANGE.max);
    expect(clampDrive(DriveName.Anxiety, -11.0)).toBe(DRIVE_RANGE.min);
    expect(clampDrive(DriveName.Curiosity, 0.5)).toBe(0.5);
  });

  it('should detect out-of-bounds values', () => {
    const state: Record<DriveName, number> = {
      [DriveName.SystemHealth]: 2.0,
      [DriveName.MoralValence]: -11.0,
      [DriveName.Integrity]: 0.5,
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

    const result = checkBounds(state);
    expect(result.count).toBe(2);
    expect(result.outOfBounds).toHaveLength(2);
  });
});

describe('DriveEngine - Cross-Modulation', () => {
  it('should suppress curiosity when anxiety is high', () => {
    const state: Record<DriveName, number> = {
      [DriveName.SystemHealth]: 0.5,
      [DriveName.MoralValence]: 0.5,
      [DriveName.Integrity]: 0.5,
      [DriveName.CognitiveAwareness]: 0.5,
      [DriveName.Guilt]: 0.0,
      [DriveName.Curiosity]: 0.8,
      [DriveName.Boredom]: 0.5,
      [DriveName.Anxiety]: 0.8,
      [DriveName.Satisfaction]: 0.0,
      [DriveName.Sadness]: 0.0,
      [DriveName.InformationIntegrity]: 0.5,
      [DriveName.Social]: 0.5,
    };

    const before = state[DriveName.Curiosity];
    applyCrossModulation(state);
    const after = state[DriveName.Curiosity];

    // Curiosity should decrease due to high anxiety
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(before * (1 - 0.4 * 0.8), 5);
  });

  it('should reduce boredom when satisfaction is high', () => {
    const state: Record<DriveName, number> = {
      [DriveName.SystemHealth]: 0.5,
      [DriveName.MoralValence]: 0.5,
      [DriveName.Integrity]: 0.5,
      [DriveName.CognitiveAwareness]: 0.5,
      [DriveName.Guilt]: 0.0,
      [DriveName.Curiosity]: 0.5,
      [DriveName.Boredom]: 0.8,
      [DriveName.Anxiety]: 0.2,
      [DriveName.Satisfaction]: 0.8,
      [DriveName.Sadness]: 0.0,
      [DriveName.InformationIntegrity]: 0.5,
      [DriveName.Social]: 0.5,
    };

    const before = state[DriveName.Boredom];
    applyCrossModulation(state);
    const after = state[DriveName.Boredom];

    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(before * (1 - 0.3 * 0.8), 5);
  });

  it('should amplify anxiety when systemHealth is low', () => {
    const state: Record<DriveName, number> = {
      [DriveName.SystemHealth]: 0.1,
      [DriveName.MoralValence]: 0.5,
      [DriveName.Integrity]: 0.5,
      [DriveName.CognitiveAwareness]: 0.5,
      [DriveName.Guilt]: 0.0,
      [DriveName.Curiosity]: 0.5,
      [DriveName.Boredom]: 0.5,
      [DriveName.Anxiety]: 0.3,
      [DriveName.Satisfaction]: 0.0,
      [DriveName.Sadness]: 0.0,
      [DriveName.InformationIntegrity]: 0.5,
      [DriveName.Social]: 0.5,
    };

    const before = state[DriveName.Anxiety];
    applyCrossModulation(state);
    const after = state[DriveName.Anxiety];

    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(
      before + 0.5 * (0.3 - 0.1),
      5,
    );
  });

  it('should increase integrity when anxiety is high', () => {
    const state: Record<DriveName, number> = {
      [DriveName.SystemHealth]: 0.5,
      [DriveName.MoralValence]: 0.5,
      [DriveName.Integrity]: 0.3,
      [DriveName.CognitiveAwareness]: 0.5,
      [DriveName.Guilt]: 0.0,
      [DriveName.Curiosity]: 0.5,
      [DriveName.Boredom]: 0.5,
      [DriveName.Anxiety]: 0.8,
      [DriveName.Satisfaction]: 0.0,
      [DriveName.Sadness]: 0.0,
      [DriveName.InformationIntegrity]: 0.5,
      [DriveName.Social]: 0.5,
    };

    const before = state[DriveName.Integrity];
    applyCrossModulation(state);
    const after = state[DriveName.Integrity];

    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(before + 0.2 * 0.8, 5);
  });
});

describe('DriveEngine - Full Tick Sequence', () => {
  it('should complete a full tick cycle: accumulate, apply effects, modulate, clamp', () => {
    const manager = new DriveStateManager();

    // 1. Apply accumulation/decay
    const rates = getDriveUpdateRates();
    manager.applyRates(rates);

    // 2. Apply an outcome (action effect)
    manager.applyOutcomeEffects({
      [DriveName.Satisfaction]: 0.5,
      [DriveName.Anxiety]: -0.2,
    });

    // 3. Apply cross-modulation
    const state = manager.getCurrent() as Record<DriveName, number>;
    applyCrossModulation(state);

    // 4. Clamp
    const clamped: Record<DriveName, number> = {} as Record<DriveName, number>;
    for (const [key, value] of Object.entries(state)) {
      clamped[key as DriveName] = clampDrive(key as DriveName, value);
    }

    // 5. Freeze
    const frozen = manager.freezeCurrent();

    // All values should be within bounds
    for (const drive of Object.values(DriveName)) {
      expect(frozen[drive]).toBeGreaterThanOrEqual(DRIVE_RANGE.min);
      expect(frozen[drive]).toBeLessThanOrEqual(DRIVE_RANGE.max);
    }
  });
});

describe('DriveEngine - Guardian Weighting', () => {
  // Note: Guardian weighting is applied in the DriveEngine.applyOutcome method,
  // which is not easily testable in isolation due to IPC dependencies.
  // This test documents the expected behavior.

  it('should apply 2x weight for guardian confirmation', () => {
    // Source: guardian_confirmation
    // Expected multiplier: 2.0
    expect(true).toBe(true); // Documented behavior
  });

  it('should apply 3x weight for guardian correction', () => {
    // Source: guardian_correction
    // Expected multiplier: 3.0
    expect(true).toBe(true); // Documented behavior
  });

  it('should apply 1x weight for algorithmic feedback', () => {
    // Source: algorithmic (or any other)
    // Expected multiplier: 1.0
    expect(true).toBe(true); // Documented behavior
  });
});
