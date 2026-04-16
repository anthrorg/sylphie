# Idea: Self-Evaluation Circuit Breaker Half-Open Hardening

**Created:** 2026-04-13
**Status:** proposed

## Summary

Fix three issues in the self-evaluation circuit breaker (`SelfEvaluationCircuitBreaker` and `SelfEvaluator`) that weaken its protection against rumination loops: the HALF_OPEN state doesn't re-trip on a single failure, `queryWithTimeout` leaks timer handles, and `assessResults` hardcodes a threshold instead of using the shared constant.

## Motivation

The circuit breaker exists to enforce CANON §E4-T008 — preventing depressive attractor states by pausing self-evaluation after consecutive negative assessments. Three problems undermine this:

**1. HALF_OPEN re-trip requires full threshold again.** When the pause expires and the breaker enters HALF_OPEN, `isOpen()` resets `consecutiveNegatives` to 0. A single negative assessment in HALF_OPEN should immediately re-open the circuit (standard circuit breaker semantics), but because the counter was zeroed, it takes another 5 consecutive negatives to re-trip. This means after every pause, the system gets 4 free rumination cycles before protection re-engages — exactly the window the breaker was designed to close.

**2. Timer leak in `queryWithTimeout`.** `SelfEvaluator.queryWithTimeout()` uses `Promise.race` with a `setTimeout`, but the losing promise's timer is never cleared. Every evaluation cycle (every 10 ticks at 1Hz = every 10 seconds) leaks one `setTimeout` handle that runs to completion even after the query resolves. Over hours of runtime this accumulates thousands of orphaned timers.

**3. Hardcoded threshold in `assessResults`.** The method checks `cap.successRate < 0.3`, but the constant `LOW_CAPABILITY_THRESHOLD` (also `0.3`) already exists in `constants/self-evaluation.ts` and is used by the baseline adjustment path. If someone tunes the threshold in the constant, `assessResults` silently diverges.

## Subsystems Affected

- drive-engine/self-evaluation (`SelfEvaluator`, `SelfEvaluationCircuitBreaker`)
- drive-engine/constants (`self-evaluation.ts`)

## Proposed Changes

1. **HALF_OPEN re-trip:** In `SelfEvaluationCircuitBreaker.recordNegativeAssessment()`, check `if (this.state === CircuitBreakerState.HALF_OPEN)` and immediately call `tripCircuit()` without waiting for the threshold. Only use the threshold counter while in CLOSED state.

2. **Timer cleanup:** Refactor `queryWithTimeout` to store the timer ID and call `clearTimeout` when the query resolves first. A simple pattern:
   ```ts
   private async queryWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T | null> {
     let timerId: ReturnType<typeof setTimeout>;
     const timeoutPromise = new Promise<null>((resolve) => {
       timerId = setTimeout(() => resolve(null), timeoutMs);
     });
     try {
       return await Promise.race([fn(), timeoutPromise]);
     } finally {
       clearTimeout(timerId!);
     }
   }
   ```

3. **Use constant:** Replace the hardcoded `0.3` in `assessResults` with `LOW_CAPABILITY_THRESHOLD` from `../constants/self-evaluation`.

## Open Questions

- Should the HALF_OPEN state allow a configurable number of "probe" evaluations (e.g., 1–2) before deciding, or is single-shot re-trip correct for this domain?
- Should the circuit breaker emit an event when it re-trips from HALF_OPEN, so the supervisor can distinguish "first trip" from "relapse"?
- Is 5 seconds (`CIRCUIT_BREAKER_PAUSE_DURATION_MS`) long enough for the OPEN pause, given that at 1Hz ticks only ~5 evaluations happen in that window anyway? An exponential backoff on repeated trips might be more robust.
