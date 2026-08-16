/**
 * Unit tests for detectTheater() reading the isolated currentDriveState —
 * TK-130. Previously currentDriveState was declared but unused; the verdict
 * was derived solely from the caller-supplied driveValueAtExpression (the
 * isolated judge trusted the defendant's testimony).
 */

import { DriveName, INITIAL_DRIVE_STATE, type PressureVector } from '@sylphie/shared';
import { detectTheater, PRESSURE_THRESHOLD, RELIEF_THRESHOLD } from './theater-prohibition';

function state(overrides: Partial<Record<DriveName, number>>): PressureVector {
  return { ...INITIAL_DRIVE_STATE, ...overrides } as PressureVector;
}

describe('detectTheater — reads isolated currentDriveState', () => {
  it('returns theatrical when the claimed value looks authentic but the isolated state disagrees (pressure)', () => {
    const currentState = state({ [DriveName.Anxiety]: 0.0 }); // isolated: well below threshold
    const verdict = detectTheater(
      {
        expressionType: 'pressure',
        driveValueAtExpression: 0.9, // claimed: well above threshold — theatrical testimony
        drive: DriveName.Anxiety,
        isTheatrical: false,
      },
      currentState,
    );

    expect(verdict.isTheatrical).toBe(true);
    expect(verdict.driveValue).toBe(0.0);
  });

  it('returns theatrical when the claimed relief looks authentic but the isolated state disagrees (relief)', () => {
    const currentState = state({ [DriveName.Satisfaction]: 0.9 }); // isolated: well above relief threshold
    const verdict = detectTheater(
      {
        expressionType: 'relief',
        driveValueAtExpression: 0.0, // claimed: well below threshold — theatrical testimony
        drive: DriveName.Satisfaction,
        isTheatrical: false,
      },
      currentState,
    );

    expect(verdict.isTheatrical).toBe(true);
    expect(verdict.driveValue).toBe(0.9);
  });

  it('returns authentic when the isolated state supports the pressure expression, regardless of the claim', () => {
    const currentState = state({ [DriveName.Anxiety]: PRESSURE_THRESHOLD + 0.1 });
    const verdict = detectTheater(
      {
        expressionType: 'pressure',
        driveValueAtExpression: 0.0, // caller's claim is irrelevant/wrong; isolated state is what matters
        drive: DriveName.Anxiety,
        isTheatrical: false,
      },
      currentState,
    );

    expect(verdict.isTheatrical).toBe(false);
    expect(verdict.driveValue).toBe(PRESSURE_THRESHOLD + 0.1);
  });

  it('returns authentic when the isolated state supports the relief expression', () => {
    const currentState = state({ [DriveName.Satisfaction]: RELIEF_THRESHOLD - 0.1 });
    const verdict = detectTheater(
      {
        expressionType: 'relief',
        driveValueAtExpression: 1.0, // caller's claim is irrelevant/wrong; isolated state is what matters
        drive: DriveName.Satisfaction,
        isTheatrical: false,
      },
      currentState,
    );

    expect(verdict.isTheatrical).toBe(false);
    expect(verdict.driveValue).toBe(RELIEF_THRESHOLD - 0.1);
  });

  it('treats "none" expressionType as never theatrical', () => {
    const currentState = state({});
    const verdict = detectTheater(
      {
        expressionType: 'none',
        driveValueAtExpression: 0,
        drive: DriveName.Curiosity,
        isTheatrical: false,
      },
      currentState,
    );

    expect(verdict.isTheatrical).toBe(false);
  });
});
