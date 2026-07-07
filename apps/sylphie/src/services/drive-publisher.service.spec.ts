/**
 * TK-117 — DrivePublisher telemetry honesty: stop emitting fabricated fields.
 */

import { Subject } from 'rxjs';
import { DrivePublisherService } from './drive-publisher.service';

describe('DrivePublisherService.publishSnapshot — no fabricated telemetry (TK-117)', () => {
  it('emits null (never the old fabricated constants) for all 9 unmeasured fields', () => {
    const driveState$ = new Subject<any>();
    const driveReader = { driveState$: driveState$.asObservable() } as any;
    const telemetry = { broadcast: jest.fn() } as any;
    const service = new DrivePublisherService(driveReader, telemetry);

    service.onModuleInit();
    driveState$.next({
      tickNumber: 7,
      totalPressure: 0.5,
      timestamp: new Date('2026-07-06T00:00:00.000Z'),
      pressureVector: { curiosity: 0.3 },
      driveDeltas: { curiosity: 0.01 },
    });

    expect(telemetry.broadcast).toHaveBeenCalledTimes(1);
    const payload = telemetry.broadcast.mock.calls[0][0];

    expect(payload.pressure_metadata.is_stale).toBeNull();
    expect(payload.drive_entropy).toBeNull();
    expect(payload.category).toBeNull();
    expect(payload.action).toBeNull();
    expect(payload.action_confidence).toBeNull();
    expect(payload.state).toBeNull();
    expect(payload.transition_count).toBeNull();
    expect(payload.speech_refractory).toBeNull();
    expect(payload.dynamic_threshold).toBeNull();

    // None of the OLD fabricated constants should appear.
    expect(payload.pressure_metadata.is_stale).not.toBe(false);
    expect(payload.drive_entropy).not.toBe(0);
    expect(payload.state).not.toBe('idle');
    expect(payload.transition_count).not.toBe(0);
    expect(payload.speech_refractory).not.toBe(0);
    expect(payload.dynamic_threshold).not.toBe(0);

    // Real, actually-measured fields are untouched.
    expect(payload.cycle_count).toBe(7);
    expect(payload.pressure.curiosity).toBe(0.3);
    expect(payload.system_health.total_pressure).toBe(0.5);

    service.onModuleDestroy();
  });
});
