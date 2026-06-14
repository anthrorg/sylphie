/**
 * llm-timeout — internal timeout guard for Learning-subsystem LLM calls.
 *
 * The learning pipeline runs on fixed-interval timers (60 s / 5 m / 30 m) and
 * each cycle type guards itself with an `inFlight` flag: if the previous run
 * has not finished, the next tick is skipped. Without a timeout on the LLM
 * call, a single hung request leaves `inFlight` true forever — that cycle type
 * silently dies until the process restarts (no new refinement, reflection, or
 * synthesis).
 *
 * `withTimeout` races the LLM promise against a deadline. On timeout it rejects
 * with an {@link LlmCallTimeoutError}, which the call site's existing try/catch
 * treats like any other LLM failure: log it, skip the step, recover on the next
 * interval. This is intentionally NOT a change to the shared LlmRequest / broker
 * contract — it is a learning-local safety net layered over `ILlmService`.
 *
 * NOTE: the underlying LLM request is not actively aborted (ILlmService.complete
 * exposes no AbortSignal). The orphaned promise is allowed to settle and is
 * ignored. This is acceptable: the hung call no longer blocks the cycle, and
 * the broker enforces its own transport-level limits. If an AbortSignal is
 * added to LlmRequest later, this helper can forward one.
 */

/** Error thrown when an LLM call does not settle within its deadline. */
export class LlmCallTimeoutError extends Error {
  constructor(
    public readonly purpose: string,
    public readonly timeoutMs: number,
  ) {
    super(`LLM call '${purpose}' timed out after ${timeoutMs}ms`);
    this.name = 'LlmCallTimeoutError';
  }
}

/**
 * Race `promise` against a `timeoutMs` deadline.
 *
 * Resolves with the promise's value if it settles first; rejects with
 * {@link LlmCallTimeoutError} if the deadline fires first. The timer is always
 * cleared so a fast-resolving call does not leak a pending timeout.
 *
 * @param promise   The in-flight LLM call (e.g. `llm.complete(request)`).
 * @param timeoutMs Deadline in milliseconds.
 * @param purpose   Human-readable label for logs / the thrown error.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  purpose: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new LlmCallTimeoutError(purpose, timeoutMs));
    }, timeoutMs);
    // Do not keep the event loop alive solely for this guard timer.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}
