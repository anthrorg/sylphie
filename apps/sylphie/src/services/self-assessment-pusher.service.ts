/**
 * SelfAssessmentPusherService — the MAIN-side producer that pushes KG(Self)
 * self-evaluation snapshots to the Drive Engine.
 *
 * Phase 4 Wave 2 cluster 3a — Ticket 1 (event-judge model). The Drive Engine
 * NEVER queries MAIN: MAIN computes a value from its own SELF graph and PUSHES
 * an event the drive judges on its own cadence. This service is one half of
 * that push path (the other being SelfAssessmentService, which does the read +
 * compute, and ActionOutcomeReporterService.pushSelfAssessment, which owns the
 * wire).
 *
 * Cadence: a single interval timer (~10s) recomputes the snapshot and pushes
 * it. Pushes are coalesced to at most one per interval via an in-flight guard —
 * if a compute is still running when the next tick fires, that tick is skipped
 * (we never stack overlapping reads of the SELF graph).
 *
 * Honesty (CANON Standard 2): the payload is whatever SelfAssessmentService
 * computed — empty arrays when the SELF graph has no Capability/DrivePattern/
 * PredictionAccuracy nodes (the bootstrap state). An empty payload is VALID and
 * is still pushed: the drive's CachedSelfKgReader flips ready on the first push
 * and self-heals neutrally. We never fabricate capabilities to avoid an "empty"
 * push.
 */

import {
  Injectable,
  Inject,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { verboseFor } from '@sylphie/shared';
import { ACTION_OUTCOME_REPORTER, type IActionOutcomeReporter } from '@sylphie/drive-engine';
import { SelfAssessmentService } from './self-assessment.service';
import { PushCoalescer } from './self-assessment-push.core';

const vlog = verboseFor('Knowledge');

/**
 * Self-assessment recompute/push cadence. ~10s matches the drive's own
 * self-evaluation read cadence (every 10 ticks); a faster push would just be
 * coalesced drive-side, a much slower one would let the cache go stale.
 */
const PUSH_INTERVAL_MS = 10_000;

@Injectable()
export class SelfAssessmentPusherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SelfAssessmentPusherService.name);

  private timer: NodeJS.Timeout | null = null;

  /**
   * Coalescing guard (decorator-free core, unit-tested separately). A timer tick
   * that fires during an in-flight compute is skipped, guaranteeing at most one
   * push per self-evaluation interval and never stacking SELF-graph reads.
   */
  private readonly coalescer = new PushCoalescer();

  constructor(
    private readonly selfAssessment: SelfAssessmentService,

    @Inject(ACTION_OUTCOME_REPORTER)
    private readonly outcomeReporter: IActionOutcomeReporter,
  ) {}

  /**
   * Start the push cadence after the whole app has bootstrapped.
   *
   * OnApplicationBootstrap (not OnModuleInit) so the Drive Engine WebSocket
   * channel has been wired by DriveEngineModule's OnModuleInit before we push.
   * If a push lands before the socket is open, WsChannelService queues it
   * internally — so even a pre-connect push is not lost — but bootstrapping
   * after init keeps the first push close to a live connection.
   *
   * We push once immediately so the drive's reader flips ready as early as
   * possible, then on every interval thereafter.
   */
  onApplicationBootstrap(): void {
    // Fire-and-forget the first push; do not block bootstrap on a SELF read.
    void this.computeAndPush();

    this.timer = setInterval(() => {
      void this.computeAndPush();
    }, PUSH_INTERVAL_MS);

    // Do not keep the event loop alive solely for this timer.
    this.timer.unref?.();

    this.logger.log(
      `Self-assessment push cadence active (interval=${PUSH_INTERVAL_MS / 1000}s, ` +
        'coalesced ≤1 push per interval).',
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Compute the current self-assessment snapshot and push it to the drive,
   * coalesced so a tick during an in-flight compute is skipped. Delegates to the
   * decorator-free PushCoalescer (unit-tested in self-assessment-push.spec.ts).
   * Never throws — the cadence survives a SELF read or send failure.
   */
  private async computeAndPush(): Promise<void> {
    await this.coalescer.run(
      () => this.selfAssessment.computeSelfAssessment(),
      (payload) => this.outcomeReporter.pushSelfAssessment(payload),
      {
        onCoalesced: () =>
          vlog('self-assessment push skipped (previous compute in flight)', {}),
        onError: (err) =>
          this.logger.warn(
            `Self-assessment compute/push failed (cadence continues): ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
      },
    );
  }
}
