/**
 * TK-80 — DrivesController contract (AC2: 501 isolation preserved).
 *
 * CANON §Drive Isolation: the main app process must not mutate drive state.
 * The setOverride / setDrift / resetOverrides endpoints must throw
 * NotImplementedException (HTTP 501) regardless of input, so no caller is
 * ever misled into thinking an override took effect.
 *
 * GET /drives (getSnapshot) remains the only real endpoint — read-only via
 * IDriveStateReader, no isolation violation.
 */

import { NotImplementedException } from '@nestjs/common';
import { DrivesController } from './drives.controller';

// Minimal IDriveStateReader stub — only getSnapshot exercises the reader.
function makeReader(overrides: Partial<{ tickNumber: number; totalPressure: number; timestamp: Date }> = {}) {
  return {
    getCurrentState: () => ({
      tickNumber: overrides.tickNumber ?? 42,
      totalPressure: overrides.totalPressure ?? 0.3,
      timestamp: overrides.timestamp ?? new Date(),
      pressureVector: {} as any,
      driveDeltas: {} as any,
    }),
  } as any;
}

describe('DrivesController — AC2: drive mutation endpoints remain 501', () => {
  let controller: DrivesController;

  beforeEach(() => {
    controller = new DrivesController(makeReader());
  });

  it('POST /drives/override throws NotImplementedException', () => {
    expect(() =>
      controller.setOverride({ drive: 'curiosity', value: 0.8, active: true }),
    ).toThrow(NotImplementedException);
  });

  it('POST /drives/drift throws NotImplementedException', () => {
    expect(() =>
      controller.setDrift({ drive: 'anxiety', rate: 0.01 }),
    ).toThrow(NotImplementedException);
  });

  it('POST /drives/reset throws NotImplementedException', () => {
    expect(() => controller.resetOverrides()).toThrow(NotImplementedException);
  });
});

describe('DrivesController — GET /drives (read-only snapshot)', () => {
  it('returns isConnected=true for a recent tick > 0', () => {
    const controller = new DrivesController(makeReader({ tickNumber: 5, timestamp: new Date() }));
    const snap = controller.getSnapshot();
    expect(snap.isConnected).toBe(true);
    expect(snap.tickNumber).toBe(5);
  });

  it('returns isConnected=false for a stale timestamp', () => {
    const staleDate = new Date(Date.now() - 5000); // 5 s ago — beyond the 2 s window
    const controller = new DrivesController(makeReader({ tickNumber: 5, timestamp: staleDate }));
    const snap = controller.getSnapshot();
    expect(snap.isConnected).toBe(false);
  });

  it('returns isConnected=false when tickNumber is 0 (no real tick yet)', () => {
    const controller = new DrivesController(makeReader({ tickNumber: 0, timestamp: new Date() }));
    const snap = controller.getSnapshot();
    expect(snap.isConnected).toBe(false);
  });
});
