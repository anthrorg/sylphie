/**
 * Unit tests for the Drive Engine emitting a real HEALTH_STATUS — TK-134.
 *
 * Previously the engine never sent HEALTH_STATUS at all (the field
 * tracking when to send it, nextHealthCheckAt, was declared but never
 * checked in the tick loop) — the main-process handler existed but could
 * never fire. Now the engine emits one every HEALTH_STATUS_INTERVAL_TICKS
 * with real memoryMb (process.memoryUsage()) and enforces the <10MB limit
 * via the `healthy` flag.
 */

import { DriveIPCMessageType, type DriveIPCMessage } from '@sylphie/shared';
import { DriveEngine } from './drive-engine';
import type { IMessageTransport } from './message-transport';

function makeTransport(): IMessageTransport & { sent: DriveIPCMessage<any>[] } {
  const sent: DriveIPCMessage<any>[] = [];
  return {
    sent,
    send: jest.fn((msg: DriveIPCMessage<any>) => sent.push(msg)),
    onMessage: jest.fn(),
  };
}

describe('DriveEngine — real HEALTH_STATUS emission', () => {
  it('emits HEALTH_STATUS with real memoryMb once the health-check tick threshold is reached', () => {
    const transport = makeTransport();
    const engine = new DriveEngine(transport);

    // Force the next health check to fire on the very next tick instead of
    // waiting HEALTH_STATUS_INTERVAL_TICKS (~60) ticks.
    (engine as any).nextHealthCheckAt = 0;

    (engine as any).tick();

    const healthMessages = transport.sent.filter(
      (m) => m.type === DriveIPCMessageType.HEALTH_STATUS,
    );
    expect(healthMessages.length).toBe(1);

    const payload = healthMessages[0].payload;
    expect(typeof payload.memoryMb).toBe('number');
    expect(payload.memoryMb).toBeGreaterThan(0);
    expect(typeof payload.healthy).toBe('boolean');
    expect(typeof payload.currentTick).toBe('number');
  });

  it('does not emit HEALTH_STATUS before the threshold is reached', () => {
    const transport = makeTransport();
    const engine = new DriveEngine(transport);

    // Default nextHealthCheckAt is HEALTH_STATUS_INTERVAL_TICKS (60); a
    // single tick (tickNumber 0 -> 1) must not cross it.
    (engine as any).tick();

    const healthMessages = transport.sent.filter(
      (m) => m.type === DriveIPCMessageType.HEALTH_STATUS,
    );
    expect(healthMessages.length).toBe(0);
  });
});
