/**
 * Unit tests for SESSION_START preserving a Timescale-restored checkpoint —
 * TK-131. Previously handleSessionStart() unconditionally overwrote drive
 * state with the payload's initialDriveState, discarding any restored
 * checkpoint. Now an ordinary SESSION_START (no forceReset) preserves it;
 * forceReset: true (the explicit reset flow) still overwrites it.
 */

import { DriveIPCMessageType, DriveName, INITIAL_DRIVE_STATE, type DriveIPCMessage } from '@sylphie/shared';
import { DriveEngine } from './drive-engine';
import type { IMessageTransport } from './message-transport';

function makeTransport() {
  let handler: ((msg: DriveIPCMessage<unknown>) => void) | null = null;
  return {
    send: jest.fn(),
    onMessage: jest.fn((h) => {
      handler = h;
    }),
    dispatch(msg: DriveIPCMessage<unknown>) {
      handler?.(msg);
    },
  } as IMessageTransport & { dispatch: (msg: DriveIPCMessage<unknown>) => void };
}

function makeRestoredCheckpoint() {
  const restoredVector: Record<string, number> = { ...INITIAL_DRIVE_STATE };
  restoredVector[DriveName.Curiosity] = 0.77;
  return { pressureVector: restoredVector, tickNumber: 42 };
}

describe('DriveEngine SESSION_START vs restored checkpoint', () => {
  it('preserves the restored checkpoint on an ordinary SESSION_START (no forceReset)', async () => {
    const transport = makeTransport();
    const engine = new DriveEngine(transport);

    const mockWriter = {
      init: jest.fn().mockResolvedValue(undefined),
      loadState: jest.fn().mockResolvedValue(makeRestoredCheckpoint()),
      saveState: jest.fn().mockResolvedValue(undefined),
    };
    engine.setTimescaleWriter(mockWriter as any);

    const restored = await engine.restoreState();
    expect(restored).toBe(true);
    expect((engine as any).stateManager.getCurrent()[DriveName.Curiosity]).toBeCloseTo(0.77);

    // Ordinary SESSION_START — must NOT overwrite the restored state.
    transport.dispatch({
      type: DriveIPCMessageType.SESSION_START,
      payload: {
        sessionId: 'session-2',
        initialDriveState: {
          pressureVector: { ...INITIAL_DRIVE_STATE },
          timestamp: new Date(),
          tickNumber: 0,
          driveDeltas: {},
          ruleMatchResult: { ruleId: null, eventType: 'SESSION_START', matched: false },
          totalPressure: 0,
          sessionId: 'session-2',
        },
      },
      timestamp: new Date(),
    } as any);

    expect((engine as any).stateManager.getCurrent()[DriveName.Curiosity]).toBeCloseTo(0.77);
    expect((engine as any).tickNumber).toBe(42);
  });

  it('overwrites the restored checkpoint when forceReset: true is set (explicit reset)', async () => {
    const transport = makeTransport();
    const engine = new DriveEngine(transport);

    const mockWriter = {
      init: jest.fn().mockResolvedValue(undefined),
      loadState: jest.fn().mockResolvedValue(makeRestoredCheckpoint()),
      saveState: jest.fn().mockResolvedValue(undefined),
    };
    engine.setTimescaleWriter(mockWriter as any);

    await engine.restoreState();
    expect((engine as any).stateManager.getCurrent()[DriveName.Curiosity]).toBeCloseTo(0.77);

    transport.dispatch({
      type: DriveIPCMessageType.SESSION_START,
      payload: {
        sessionId: 'reset-1',
        forceReset: true,
        initialDriveState: {
          pressureVector: { ...INITIAL_DRIVE_STATE },
          timestamp: new Date(),
          tickNumber: 0,
          driveDeltas: {},
          ruleMatchResult: { ruleId: null, eventType: 'SESSION_START', matched: false },
          totalPressure: 0,
          sessionId: 'reset-1',
        },
      },
      timestamp: new Date(),
    } as any);

    expect((engine as any).stateManager.getCurrent()[DriveName.Curiosity]).toBeCloseTo(0);
  });

  it('applies the payload state normally on a true cold start (no checkpoint restored)', () => {
    const transport = makeTransport();
    const engine = new DriveEngine(transport);

    const coldVector: Record<string, number> = { ...INITIAL_DRIVE_STATE };
    coldVector[DriveName.Boredom] = 0.5;

    transport.dispatch({
      type: DriveIPCMessageType.SESSION_START,
      payload: {
        sessionId: 'session-1',
        initialDriveState: {
          pressureVector: coldVector,
          timestamp: new Date(),
          tickNumber: 0,
          driveDeltas: {},
          ruleMatchResult: { ruleId: null, eventType: 'SESSION_START', matched: false },
          totalPressure: 0.5,
          sessionId: 'session-1',
        },
      },
      timestamp: new Date(),
    } as any);

    expect((engine as any).stateManager.getCurrent()[DriveName.Boredom]).toBeCloseTo(0.5);
  });
});
