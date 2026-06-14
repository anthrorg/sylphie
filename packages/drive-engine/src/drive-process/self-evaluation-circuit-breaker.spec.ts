/**
 * Unit tests for the self-evaluation circuit breaker.
 *
 * Regression coverage for the HALF_OPEN hardening bug: a single failed probe
 * in HALF_OPEN must immediately re-trip the circuit rather than granting
 * (threshold - 1) free rumination cycles (CANON §E4-T008).
 */

import {
  SelfEvaluationCircuitBreaker,
  CircuitBreakerState,
} from './self-evaluation-circuit-breaker';
import {
  CIRCUIT_BREAKER_NEGATIVE_THRESHOLD,
  CIRCUIT_BREAKER_PAUSE_DURATION_MS,
} from '../constants/self-evaluation';

describe('SelfEvaluationCircuitBreaker', () => {
  let cb: SelfEvaluationCircuitBreaker;

  beforeEach(() => {
    cb = new SelfEvaluationCircuitBreaker();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts CLOSED', () => {
    expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
    expect(cb.isOpen()).toBe(false);
  });

  it('trips to OPEN after the threshold of consecutive negatives', () => {
    for (let i = 0; i < CIRCUIT_BREAKER_NEGATIVE_THRESHOLD; i++) {
      cb.recordNegativeAssessment();
    }
    expect(cb.getState()).toBe(CircuitBreakerState.OPEN);
    expect(cb.isOpen()).toBe(true);
  });

  it('transitions OPEN -> HALF_OPEN after the pause elapses', () => {
    jest.useFakeTimers();
    for (let i = 0; i < CIRCUIT_BREAKER_NEGATIVE_THRESHOLD; i++) {
      cb.recordNegativeAssessment();
    }
    expect(cb.getState()).toBe(CircuitBreakerState.OPEN);

    // Advance past the pause window.
    jest.advanceTimersByTime(CIRCUIT_BREAKER_PAUSE_DURATION_MS + 1);

    // isOpen() drives the transition and allows one probe evaluation.
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe(CircuitBreakerState.HALF_OPEN);
  });

  it('re-trips to OPEN on a SINGLE failed probe in HALF_OPEN', () => {
    jest.useFakeTimers();
    for (let i = 0; i < CIRCUIT_BREAKER_NEGATIVE_THRESHOLD; i++) {
      cb.recordNegativeAssessment();
    }
    jest.advanceTimersByTime(CIRCUIT_BREAKER_PAUSE_DURATION_MS + 1);
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe(CircuitBreakerState.HALF_OPEN);

    // A single negative in HALF_OPEN must immediately re-open — no free cycles.
    cb.recordNegativeAssessment();
    expect(cb.getState()).toBe(CircuitBreakerState.OPEN);
    expect(cb.isOpen()).toBe(true);
  });

  it('closes from HALF_OPEN on a positive probe', () => {
    jest.useFakeTimers();
    for (let i = 0; i < CIRCUIT_BREAKER_NEGATIVE_THRESHOLD; i++) {
      cb.recordNegativeAssessment();
    }
    jest.advanceTimersByTime(CIRCUIT_BREAKER_PAUSE_DURATION_MS + 1);
    cb.isOpen();
    expect(cb.getState()).toBe(CircuitBreakerState.HALF_OPEN);

    cb.recordPositiveAssessment();
    expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
  });
});
