/**
 * VerdictAuditService — persists supervisor verdicts to the TimescaleDB event
 * backbone for an auditable trail.
 *
 * CANON §Standard 2 (Provenance Is Sacred): a DeepSeek supervisor verdict is an
 * LLM-generated *judgement*, not ground truth. Each verdict is persisted with
 * truthful `LLM_GENERATED` provenance and the model identifier that produced
 * it, so an operator can later answer "why did the supervisor flag cycle X, and
 * what was its chain-of-thought?" — exactly the audit signal the supervisor
 * exists to provide (closes §2.4's audit-blindness gap end-to-end).
 *
 * Persistence follows the existing forwarding pattern used by
 * DecisionEventLoggerService: buffered, batched multi-row INSERTs into the
 * shared `events` hypertable. The only differences are `subsystem='SUPERVISOR'`
 * and `type='SUPERVISOR_VERDICT'`. If TimescaleService is unavailable (tests,
 * cold start), verdicts are logged at warn level and dropped — never thrown,
 * because the audit leg must never block or crash the (already fire-and-forget)
 * supervisor evaluation path.
 */

import {
  Injectable,
  Logger,
  Optional,
  Inject,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TimescaleService } from '@sylphie/shared';
import type {
  VerdictAuditRecord,
} from './interfaces/supervisor.types';

interface BufferedVerdict {
  readonly id: string;
  readonly record: VerdictAuditRecord;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly timestamp: Date;
}

@Injectable()
export class VerdictAuditService implements OnModuleDestroy {
  private readonly logger = new Logger(VerdictAuditService.name);

  private buffer: BufferedVerdict[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly BATCH_SIZE = 10;
  private readonly FLUSH_INTERVAL_MS = 250;

  constructor(
    @Optional() @Inject(TimescaleService) private readonly timescale: TimescaleService | null,
  ) {}

  /**
   * Record a supervisor verdict to the audit trail (buffered).
   *
   * Synchronous and non-throwing: schedules a flush, never awaits it. The
   * cycleId doubles as the correlation id so a verdict can be joined back to
   * the decision-making events for the same cycle.
   */
  record(record: VerdictAuditRecord): void {
    this.buffer.push({
      id: randomUUID(),
      record,
      sessionId: record.verdict.cycleId,
      correlationId: record.verdict.cycleId,
      timestamp: record.verdict.timestamp ?? new Date(),
    });

    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.length >= this.BATCH_SIZE) {
      void this.flush();
    } else {
      this.flushTimer = setTimeout(() => {
        void this.flush();
      }, this.FLUSH_INTERVAL_MS);
    }
  }

  /** Force-flush buffered verdicts to TimescaleDB. Never throws. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const items = this.buffer.splice(0);
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (!this.timescale) {
      this.logger.warn(
        `TimescaleService unavailable, discarding ${items.length} supervisor verdict(s)`,
      );
      return;
    }

    try {
      const { sql, params } = this.buildBatchInsert(items);
      await this.timescale.query(sql, params);
    } catch (err) {
      this.logger.error(
        `Failed to persist ${items.length} supervisor verdict(s): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Build a parameterized multi-row INSERT for a batch of verdicts.
   *
   * Mirrors DecisionEventLoggerService.buildBatchInsert (9 columns per row) so
   * supervisor verdicts land in the same `events` hypertable, queryable with
   * the same tooling. `drive_snapshot` is the cycle's drive vector if the
   * verdict carried one, else null.
   */
  buildBatchInsert(items: BufferedVerdict[]): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const valueStrings: string[] = [];

    items.forEach((item, index) => {
      const base = index * 9;

      // Truthful provenance is baked into the persisted payload (Std 2).
      const payload = {
        provenance: item.record.provenance, // 'LLM_GENERATED'
        model: item.record.model,
        evaluationReason: item.record.evaluationReason,
        verdict: {
          cycleId: item.record.verdict.cycleId,
          rating: item.record.verdict.rating,
          confidence: item.record.verdict.confidence,
          reasoning: item.record.verdict.reasoning,
          reasoningTrace: item.record.verdict.reasoningTrace ?? null,
          flagForGuardian: item.record.verdict.flagForGuardian,
          flagReason: item.record.verdict.flagReason ?? null,
          suggestedCorrection: item.record.verdict.suggestedCorrection ?? null,
          inputTokens: item.record.verdict.inputTokens,
          outputTokens: item.record.verdict.outputTokens,
          costUsd: item.record.verdict.costUsd,
        },
      };

      params.push(
        item.id,                       // id
        'SUPERVISOR_VERDICT',          // type
        item.timestamp,                // timestamp
        'SUPERVISOR',                  // subsystem
        item.sessionId,                // session_id
        null,                          // drive_snapshot (verdict has no full snapshot)
        JSON.stringify(payload),       // payload
        item.correlationId,            // correlation_id (= cycleId)
        1,                             // schema_version
      );

      valueStrings.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, ` +
          `$${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`,
      );
    });

    const sql =
      `INSERT INTO events (id, type, timestamp, subsystem, session_id, drive_snapshot, payload, correlation_id, schema_version) ` +
      `VALUES ${valueStrings.join(', ')}`;

    return { sql, params };
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }
}
