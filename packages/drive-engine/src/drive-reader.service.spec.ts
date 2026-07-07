/**
 * Unit tests for DriveReaderService's staleness anchor — TK-132.
 *
 * Previously the anchor (lastValidSnapshotTimestamp) only advanced on a
 * successfully cached snapshot. A single >5s gap meant the rejected snapshot
 * never moved the anchor forward, so every later snapshot was compared
 * against the same frozen (now ancient) anchor and rejected as stale too —
 * permanently. Now the anchor advances on every snapshot received, valid or
 * not, so at most one snapshot per gap is rejected.
 */

import { DriveReaderService } from './drive-reader.service';
import { DriveName, INITIAL_DRIVE_STATE, type DriveSnapshot } from '@sylphie/shared';

function makeSnapshot(overrides: Partial<DriveSnapshot> = {}): DriveSnapshot {
  const pressureVector = { ...INITIAL_DRIVE_STATE, [DriveName.Curiosity]: 0.3 };
  return {
    pressureVector,
    timestamp: new Date(),
    tickNumber: 10,
    driveDeltas: {} as any,
    ruleMatchResult: { ruleId: null, eventType: 'DRIVE_TICK', matched: false },
    totalPressure: 0.3,
    sessionId: 's1',
    ...overrides,
  };
}

describe('DriveReaderService staleness anchor', () => {
  it('a single >5s gap does not permanently lock the reader — the next valid snapshot is accepted', () => {
    const reader = new DriveReaderService();
    const t0 = Date.now();

    // First valid snapshot establishes the anchor.
    reader.updateSnapshot(makeSnapshot({ tickNumber: 1, timestamp: new Date(t0) }));
    expect(reader.getCurrentState().tickNumber).toBe(1);

    // A snapshot arriving >5s later is rejected as stale (throws) — this is
    // the expected single-gap rejection.
    expect(() =>
      reader.updateSnapshot(makeSnapshot({ tickNumber: 2, timestamp: new Date(t0 + 6000) })),
    ).toThrow(/stale/i);
    // Cached state is unchanged by the rejected snapshot.
    expect(reader.getCurrentState().tickNumber).toBe(1);

    // The NEXT snapshot, shortly after the rejected one (not >5s from it),
    // must be accepted — the reader resumes instead of staying locked out.
    expect(() =>
      reader.updateSnapshot(makeSnapshot({ tickNumber: 3, timestamp: new Date(t0 + 6500) })),
    ).not.toThrow();
    expect(reader.getCurrentState().tickNumber).toBe(3);
  });

  it('without the fix the bug would compound: verifies the anchor moved past the rejected snapshot', () => {
    const reader = new DriveReaderService();
    const t0 = Date.now();

    reader.updateSnapshot(makeSnapshot({ tickNumber: 1, timestamp: new Date(t0) }));

    try {
      reader.updateSnapshot(makeSnapshot({ tickNumber: 2, timestamp: new Date(t0 + 10_000) }));
    } catch {
      // expected — stale
    }

    // A snapshot only 1s after the rejected (stale) one must NOT be treated
    // as another >5s gap from a frozen old anchor.
    expect(() =>
      reader.updateSnapshot(makeSnapshot({ tickNumber: 3, timestamp: new Date(t0 + 11_000) })),
    ).not.toThrow();
    expect(reader.getCurrentState().tickNumber).toBe(3);
  });
});
