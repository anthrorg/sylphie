/**
 * Unit tests for DriveStateManager's NaN guard on partial pressure vectors —
 * TK-136. Previously copyState() read state[drive] directly with no
 * fallback: a partial vector (missing a drive key, e.g. from an old
 * checkpoint row or a hand-built payload) produced `undefined` for that
 * drive, which poisoned every downstream arithmetic op
 * (`undefined + rate === NaN`) for the life of the process.
 */

import { DriveName, INITIAL_DRIVE_STATE, type PressureVector } from '@sylphie/shared';
import { DriveStateManager } from './drive-state';

describe('DriveStateManager — NaN guard on partial pressure vectors', () => {
  it('fills a missing drive key with the INITIAL_DRIVE_STATE default instead of NaN', () => {
    const partial = { ...INITIAL_DRIVE_STATE } as Record<string, number>;
    delete partial[DriveName.Curiosity];

    const manager = new DriveStateManager(partial as unknown as PressureVector);
    const current = manager.getCurrent();

    expect(current[DriveName.Curiosity]).toBe(INITIAL_DRIVE_STATE[DriveName.Curiosity]);
    expect(Number.isNaN(current[DriveName.Curiosity])).toBe(false);
  });

  it('guards an explicit undefined/NaN value in the input vector', () => {
    const partial = {
      ...INITIAL_DRIVE_STATE,
      [DriveName.Anxiety]: undefined as unknown as number,
      [DriveName.Boredom]: NaN,
    };

    const manager = new DriveStateManager(partial as unknown as PressureVector);
    const current = manager.getCurrent();

    expect(Number.isNaN(current[DriveName.Anxiety])).toBe(false);
    expect(Number.isNaN(current[DriveName.Boredom])).toBe(false);
  });

  it('no NaN propagates to consumers after applyRates() on a partial vector', () => {
    const partial = { ...INITIAL_DRIVE_STATE } as Record<string, number>;
    delete partial[DriveName.Social];

    const manager = new DriveStateManager(partial as unknown as PressureVector);
    manager.applyRates({
      [DriveName.SystemHealth]: 0,
      [DriveName.MoralValence]: 0,
      [DriveName.Integrity]: 0,
      [DriveName.CognitiveAwareness]: 0,
      [DriveName.Guilt]: 0,
      [DriveName.Curiosity]: 0.001,
      [DriveName.Boredom]: 0.001,
      [DriveName.Anxiety]: 0,
      [DriveName.Satisfaction]: 0,
      [DriveName.Sadness]: 0,
      [DriveName.Focus]: 0,
      [DriveName.Social]: 0.001,
    } as Record<DriveName, number>);

    const frozen = manager.freezeCurrent();
    for (const value of Object.values(frozen)) {
      expect(Number.isNaN(value as number)).toBe(false);
    }
  });

  it('preserves a genuinely complete vector unchanged (no unwanted fallback)', () => {
    const complete = { ...INITIAL_DRIVE_STATE, [DriveName.Curiosity]: 0.42 };
    const manager = new DriveStateManager(complete);
    expect(manager.getCurrent()[DriveName.Curiosity]).toBe(0.42);
  });
});
