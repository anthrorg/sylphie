/**
 * Decorator-free core of the SELF_ASSESSMENT push producer
 * (Phase 4 Wave 2 cluster 3a — Ticket 1).
 *
 * The NestJS SelfAssessmentPusherService is a thin lifecycle shell (timer +
 * DI) around this pure logic. Keeping the testable unit free of NestJS
 * parameter decorators lets it run under the house `npx tsx` spec pattern
 * without experimentalDecorators (esbuild rejects parameter decorators).
 *
 * Honesty (CANON Standard 2): the payload pushed is whatever the compute
 * returns — empty arrays when the SELF graph is empty. An empty payload is
 * VALID and is still pushed (the drive's reader flips ready on first push and
 * self-heals neutrally). Never gate the push on non-emptiness; never fabricate.
 */

import type { SelfAssessmentPayload } from '@sylphie/shared';

/** What the core needs from the compute side (SelfAssessmentService). */
export type ComputeSelfAssessment = () => Promise<SelfAssessmentPayload>;

/** What the core needs from the push side (the IPC reporter). */
export type PushSelfAssessment = (payload: SelfAssessmentPayload) => void;

/** Optional hooks so the lifecycle shell can log without coupling the core. */
export interface PushObserver {
  /** A tick was skipped because a previous compute was still in flight. */
  onCoalesced?(): void;
  /** The compute or push threw; the cadence continues. */
  onError?(err: unknown): void;
}

/**
 * Coalescing guard for the push cadence. Guarantees at most one in-flight
 * compute at a time: a call made while a compute is still running is skipped
 * (returns false without starting a new compute). This bounds SELF-graph reads
 * to ≤1 per self-evaluation interval even if the timer fires faster.
 */
export class PushCoalescer {
  private inFlight = false;

  /**
   * Run one coalesced compute-and-push.
   *
   * @returns true if a compute ran (pushed or errored), false if it was
   *          coalesced away because a previous compute was still in flight.
   */
  async run(
    compute: ComputeSelfAssessment,
    push: PushSelfAssessment,
    observer?: PushObserver,
  ): Promise<boolean> {
    if (this.inFlight) {
      observer?.onCoalesced?.();
      return false;
    }
    this.inFlight = true;
    try {
      const payload = await compute();
      // Empty payload is valid and MUST still be pushed.
      push(payload);
    } catch (err) {
      // Never propagate — the timer-driven cadence must survive a SELF read or
      // send failure. (SelfAssessmentService already degrades a read failure to
      // an empty INFERENCE payload, so reaching here is an unexpected error.)
      observer?.onError?.(err);
    } finally {
      this.inFlight = false;
    }
    return true;
  }

  /** True while a compute is in flight (diagnostics/tests). */
  get busy(): boolean {
    return this.inFlight;
  }
}
