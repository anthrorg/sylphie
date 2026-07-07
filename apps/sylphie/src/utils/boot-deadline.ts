import { Logger } from '@nestjs/common';

const logger = new Logger('BootDeadline');

/**
 * TK-111 — shared boot-deadline helper.
 *
 * Races `work` against a `ms`-millisecond timeout so a stalled boot-time
 * operation (a stuck Neo4j MERGE, a hanging schema-ensure call, etc.) can
 * never block NestFactory.create(). Replaces the inline `Promise.race`
 * pattern previously duplicated in wkg-bootstrap.service.ts and
 * wkg-query.service.ts (and now used by person-model.service.ts and
 * face-snapshot.service.ts too) with one implementation.
 *
 * Each call site passes its OWN `ms` — there is no default/shared timeout
 * constant, so two concurrent calls with different `ms` values never share
 * timer state.
 *
 * Degrades gracefully: on timeout OR a `work` rejection, logs with context
 * and resolves to `undefined` rather than throwing — the caller decides
 * what "degraded mode" means (skip a step, log a warning, etc.), matching
 * the existing wkg-bootstrap.service.ts precedent of never blocking boot.
 *
 * Guarantees no unhandled rejection: `work` is given its OWN independent
 * `.catch()` (separate from the `Promise.race` below), so if the deadline
 * wins the race and `work` rejects LATE — after this function has already
 * returned — that late rejection is still observed and logged, never left
 * to surface as a process-level `unhandledRejection`.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadlineFired = false;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      deadlineFired = true;
      reject(new Error(`${label} timed out after ${ms} ms`));
    }, ms);
  });

  // Independent handler on `work` itself — guarantees a rejection that
  // arrives AFTER the deadline has already won the race is observed and
  // logged, not left as an unhandled rejection. Only logs when it actually
  // fires after the deadline; the normal (work-wins) rejection path is
  // already logged by the catch block below, so this stays silent then.
  work.catch((err) => {
    if (deadlineFired) {
      logger.error(
        `${label}: work rejected after its ${ms}ms deadline had already fired: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });

  try {
    return await Promise.race([work, deadline]);
  } catch (err) {
    logger.error(
      `${label} failed within ${ms}ms: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  } finally {
    // Always clear the timer so it cannot keep the event loop alive after
    // this function returns, whether `work` won or the deadline fired.
    clearTimeout(timer);
  }
}
