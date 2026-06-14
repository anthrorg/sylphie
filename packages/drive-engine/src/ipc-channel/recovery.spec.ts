/**
 * Unit tests for RecoveryMechanism jitter + iterative-retry hardening.
 *
 * Regression coverage for:
 *   - recursive self-call replaced by an iterative loop (no stack growth)
 *   - jitter applied to backoff (thundering-herd mitigation)
 *   - incrementReconnectCount guarded against being undefined
 *   - pendingMessageCount sourced from a provider instead of hardcoded 0
 */

import { RecoveryMechanism } from './recovery';

// Minimal stubs for the collaborators.
function makeHealthMonitor(healthy: boolean) {
  return {
    getHealthReport: () => ({ healthy }),
  } as any;
}

function makeWsChannel(opts?: {
  failConnect?: number; // number of leading connect() calls that throw
  hasIncrement?: boolean;
}) {
  let connectCalls = 0;
  const failConnect = opts?.failConnect ?? 0;
  const channel: any = {
    connectCalls: 0,
    reconnectCount: 0,
    close: jest.fn().mockResolvedValue(undefined),
    connect: jest.fn(() => {
      connectCalls++;
      channel.connectCalls = connectCalls;
      if (connectCalls <= failConnect) {
        throw new Error(`connect failure #${connectCalls}`);
      }
    }),
  };
  if (opts?.hasIncrement !== false) {
    channel.incrementReconnectCount = jest.fn(() => {
      channel.reconnectCount++;
    });
  }
  return channel;
}

describe('RecoveryMechanism', () => {
  it('no-ops and resets when the child is healthy', async () => {
    const ws = makeWsChannel();
    const rm = new RecoveryMechanism(ws, makeHealthMonitor(true), 'ws://x');
    const result = await rm.attemptRecovery();
    expect(result).toBe(true);
    expect(ws.connect).not.toHaveBeenCalled();
  });

  it('reconnects successfully on the first attempt (unhealthy)', async () => {
    const ws = makeWsChannel();
    const rm = new RecoveryMechanism(ws, makeHealthMonitor(false), 'ws://x', {
      initialDelayMs: 1,
      jitterFraction: 0,
    });
    const result = await rm.attemptRecovery();
    expect(result).toBe(true);
    expect(ws.connect).toHaveBeenCalledTimes(1);
    expect(ws.incrementReconnectCount).toHaveBeenCalledTimes(1);
    expect(ws.reconnectCount).toBe(1);
  });

  it('retries iteratively on failed connects and enters safe mode after maxRetries', async () => {
    // All connects fail → exhaust the retry budget.
    const ws = makeWsChannel({ failConnect: 10 });
    const rm = new RecoveryMechanism(ws, makeHealthMonitor(false), 'ws://x', {
      initialDelayMs: 1,
      maxRetries: 3,
      jitterFraction: 0,
    });
    const result = await rm.attemptRecovery();
    expect(result).toBe(false);
    expect(rm.isSafeModeAlert()).toBe(true);
    // Exactly maxRetries reconnect attempts — bounded, no runaway.
    expect(ws.connect).toHaveBeenCalledTimes(3);
  });

  it('eventually succeeds when a later connect attempt works', async () => {
    // First two connects fail, third succeeds.
    const ws = makeWsChannel({ failConnect: 2 });
    const rm = new RecoveryMechanism(ws, makeHealthMonitor(false), 'ws://x', {
      initialDelayMs: 1,
      maxRetries: 5,
      jitterFraction: 0,
    });
    const result = await rm.attemptRecovery();
    expect(result).toBe(true);
    expect(ws.connect).toHaveBeenCalledTimes(3);
    expect(rm.isSafeModeAlert()).toBe(false);
  });

  it('does not throw when incrementReconnectCount is undefined', async () => {
    const ws = makeWsChannel({ hasIncrement: false });
    expect(ws.incrementReconnectCount).toBeUndefined();
    const rm = new RecoveryMechanism(ws, makeHealthMonitor(false), 'ws://x', {
      initialDelayMs: 1,
      jitterFraction: 0,
    });
    const result = await rm.attemptRecovery();
    expect(result).toBe(true);
    expect(ws.connect).toHaveBeenCalledTimes(1);
  });

  it('applies jitter within +/- the configured fraction of the base delay', () => {
    const ws = makeWsChannel();
    const rm = new RecoveryMechanism(ws, makeHealthMonitor(false), 'ws://x', {
      initialDelayMs: 1000,
      jitterFraction: 0.25,
    });
    const applyJitter = (rm as any).applyJitter.bind(rm);
    for (let i = 0; i < 200; i++) {
      const v = applyJitter(1000);
      expect(v).toBeGreaterThanOrEqual(750);
      expect(v).toBeLessThanOrEqual(1250);
    }
  });

  it('jitterFraction=0 returns the delay unchanged', () => {
    const ws = makeWsChannel();
    const rm = new RecoveryMechanism(ws, makeHealthMonitor(false), 'ws://x', {
      jitterFraction: 0,
    });
    const applyJitter = (rm as any).applyJitter.bind(rm);
    expect(applyJitter(4000)).toBe(4000);
  });

  it('reports pendingMessageCount from the provider', () => {
    const ws = makeWsChannel();
    const rm = new RecoveryMechanism(ws, makeHealthMonitor(true), 'ws://x', {
      pendingMessageProvider: () => 7,
    });
    expect(rm.getState().pendingMessageCount).toBe(7);
  });

  it('defaults pendingMessageCount to 0 with no provider', () => {
    const ws = makeWsChannel();
    const rm = new RecoveryMechanism(ws, makeHealthMonitor(true), 'ws://x');
    expect(rm.getState().pendingMessageCount).toBe(0);
  });
});
