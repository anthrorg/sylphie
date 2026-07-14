/**
 * TK-116 — SensoryLoggerService interval leak on shutdown.
 */

import { SensoryLoggerService } from './sensory-logger.service';

describe('SensoryLoggerService — OnModuleDestroy clears the sampling interval (TK-116)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('onModuleDestroy clears the interval started in onModuleInit', () => {
    const tickSampler = { sample: jest.fn().mockResolvedValue({ active_modalities: [], fused_embedding: [] }) } as any;
    const telemetry = { sendLog: jest.fn() } as any;
    const service = new SensoryLoggerService(tickSampler, telemetry);

    const clearSpy = jest.spyOn(global, 'clearInterval');

    service.onModuleInit();
    const handle = (service as any).interval;
    expect(handle).not.toBeNull();

    service.onModuleDestroy();

    expect(clearSpy).toHaveBeenCalledWith(handle);
    expect((service as any).interval).toBeNull();

    // Advancing timers after destroy must not trigger another sample().
    tickSampler.sample.mockClear();
    jest.advanceTimersByTime(10_000);
    expect(tickSampler.sample).not.toHaveBeenCalled();

    clearSpy.mockRestore();
  });

  it('is safe to call onModuleDestroy without onModuleInit having run', () => {
    const tickSampler = { sample: jest.fn() } as any;
    const telemetry = { sendLog: jest.fn() } as any;
    const service = new SensoryLoggerService(tickSampler, telemetry);

    expect(() => service.onModuleDestroy()).not.toThrow();
  });
});
