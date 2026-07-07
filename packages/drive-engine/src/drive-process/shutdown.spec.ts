/**
 * Unit tests for gracefulShutdown() — TK-137 (fork checkpoint/exit race).
 *
 * Previously main.ts called `engine.stop()` (async — awaits a checkpoint
 * save) WITHOUT awaiting it, then called `process.exit(0)` immediately —
 * racing the save against the process actually exiting. These tests prove
 * exit is only called AFTER the engine's stop() (checkpoint save) resolves.
 */

import { gracefulShutdown, type StoppableEngine } from './shutdown';

describe('gracefulShutdown', () => {
  it('calls exit() only AFTER engine.stop() (the checkpoint save) resolves', async () => {
    const order: string[] = [];
    let resolveStop: () => void;
    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });

    const engine: StoppableEngine = {
      stop: jest.fn(async () => {
        order.push('stop-called');
        await stopPromise;
        order.push('stop-resolved');
      }),
    };

    const exit = jest.fn(() => {
      order.push('exit-called');
    });

    const shutdownPromise = gracefulShutdown(engine, 'SIGTERM', exit, () => {});

    // Give the microtask queue a chance to run up to the await inside stop().
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['stop-called']);
    expect(exit).not.toHaveBeenCalled();

    // Now let the checkpoint save complete.
    resolveStop!();
    await shutdownPromise;

    expect(order).toEqual(['stop-called', 'stop-resolved', 'exit-called']);
    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('still calls exit() if engine.stop() rejects (does not hang the process)', async () => {
    const engine: StoppableEngine = {
      stop: jest.fn().mockRejectedValue(new Error('save failed')),
    };
    const exit = jest.fn();

    await gracefulShutdown(engine, 'SIGINT', exit, () => {});

    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
