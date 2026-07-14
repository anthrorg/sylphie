/**
 * TK-111 — shared boot-deadline helper.
 */

import * as fs from 'fs';
import * as path from 'path';
import { withDeadline } from './boot-deadline';

function neverResolves<T>(): Promise<T> {
  return new Promise<T>(() => {
    /* deliberately never settles */
  });
}

describe('withDeadline (TK-111)', () => {
  it('returns the resolved value when work wins before the deadline', async () => {
    const result = await withDeadline(Promise.resolve('ok'), 50, 'quick-op');
    expect(result).toBe('ok');
  });

  it('returns undefined and logs when work never resolves within ms (stalled-driver simulation)', async () => {
    jest.useFakeTimers();
    try {
      const promise = withDeadline(neverResolves<string>(), 15_000, 'PersonModelService.onModuleInit');
      jest.advanceTimersByTime(15_000);
      const result = await promise;
      expect(result).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns undefined when work rejects before the deadline (non-timeout failure surfaces the same way)', async () => {
    const result = await withDeadline(Promise.reject(new Error('boom')), 5_000, 'some-op');
    expect(result).toBeUndefined();
  });

  it('a LATE rejection (after the deadline already won) never becomes an unhandledRejection', async () => {
    jest.useFakeTimers();
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    let rejectLate!: (err: Error) => void;
    const lateWork = new Promise<void>((_resolve, reject) => {
      rejectLate = reject;
    });

    try {
      const promise = withDeadline(lateWork, 1_000, 'late-rejector');
      jest.advanceTimersByTime(1_000);
      const result = await promise;
      expect(result).toBeUndefined();

      // NOW the work rejects, well after the deadline already resolved.
      rejectLate(new Error('late failure'));
      // Flush microtasks so the independent .catch() on `work` runs.
      jest.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      jest.useRealTimers();
    }
  });

  it('two concurrent calls with different ms values each resolve/time out on their OWN value — no shared timer state', async () => {
    jest.useFakeTimers();
    try {
      const shortCall = withDeadline(neverResolves<string>(), 15_000, 'person-model-style');
      const longCall = withDeadline(neverResolves<string>(), 20_000, 'face-snapshot-style');

      jest.advanceTimersByTime(15_000);
      const shortResult = await shortCall;
      expect(shortResult).toBeUndefined();

      jest.advanceTimersByTime(5_000); // now at 20_000 total
      const longResult = await longCall;
      expect(longResult).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('wkg-bootstrap.service.ts and wkg-query.service.ts have zero inline Promise.race duplicates outside the shared helper', () => {
    const bootstrapSrc = fs.readFileSync(
      path.resolve(__dirname, '../services/wkg-bootstrap.service.ts'),
      'utf-8',
    );
    const querySrc = fs.readFileSync(
      path.resolve(__dirname, '../services/wkg-query.service.ts'),
      'utf-8',
    );

    expect(bootstrapSrc).not.toMatch(/Promise\.race/);
    expect(querySrc).not.toMatch(/Promise\.race/);
    expect(bootstrapSrc).toMatch(/withDeadline/);
    expect(querySrc).toMatch(/withDeadline/);
  });
});
