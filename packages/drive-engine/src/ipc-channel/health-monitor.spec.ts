/**
 * Unit tests for HealthMonitor — TK-134.
 *
 * Previously getHealthReport() fabricated lastPingAt (always `new Date()`,
 * i.e. "now") and childMemoryBytes (hardcoded null) — the <10MB memory
 * criterion was unenforceable from the main-process side because no real
 * value was ever received. recordHealthStatus() now feeds it a real value
 * from the child's own HEALTH_STATUS message.
 */

import { HealthMonitor } from './health-monitor';

function makeWsChannel() {
  return {
    getConnectionInfo: () => ({ connected: true, url: 'ws://x', uptime: 1000, reconnectCount: 0 }),
  } as any;
}

describe('HealthMonitor — real childMemoryBytes/lastPingAt (not fabricated)', () => {
  it('reports childMemoryBytes: null and an epoch lastPingAt before any HEALTH_STATUS is received', () => {
    const monitor = new HealthMonitor(makeWsChannel());
    const report = monitor.getHealthReport();
    expect(report.childMemoryBytes).toBeNull();
    // Not fabricated as "now" — epoch sentinel until a real ping arrives.
    expect(report.lastPingAt.getTime()).toBe(0);
  });

  it('reports the real memory value and a real recent lastPingAt after recordHealthStatus()', () => {
    const monitor = new HealthMonitor(makeWsChannel());
    const before = Date.now();

    monitor.recordHealthStatus({ memoryMb: 7.5 });

    const report = monitor.getHealthReport();
    expect(report.childMemoryBytes).toBe(Math.round(7.5 * 1024 * 1024));
    expect(report.lastPingAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('calls onUnhealthy when a periodic check finds the process unhealthy', () => {
    jest.useFakeTimers();
    const onUnhealthy = jest.fn();
    const monitor = new HealthMonitor(makeWsChannel(), {
      checkIntervalMs: 10,
      heartbeatTimeoutMs: 5,
      onUnhealthy,
    });

    monitor.start();
    jest.advanceTimersByTime(50);
    monitor.stop();

    expect(onUnhealthy).toHaveBeenCalled();
    jest.useRealTimers();
  });
});
