/**
 * Exception classes for the Planning module.
 *
 * All planning-specific errors inherit from PlanningException.
 * Exceptions are thrown only for unexpected infrastructure failures;
 * expected pipeline outcomes (insufficient evidence, rate limiting, etc.)
 * are represented as variants in PlanningResult instead.
 */

/**
 * Base exception for all Planning module errors.
 */
export class PlanningException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanningException';
    Object.setPrototypeOf(this, PlanningException.prototype);
  }
}

/**
 * Thrown when the research phase does not find sufficient evidence to proceed
 * to simulation. This is an expected outcome, not an error — it is handled by
 * returning { status: 'INSUFFICIENT_EVIDENCE' } in the PlanningResult.
 *
 * If this exception is thrown, it indicates an unexpected failure in the
 * evidence-gathering infrastructure (e.g., a database query failed).
 */
export class InsufficientEvidenceError extends PlanningException {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientEvidenceError';
    Object.setPrototypeOf(this, InsufficientEvidenceError.prototype);
  }
}

/**
 * Thrown when simulation produces zero candidates with a positive expected value.
 * This is an expected outcome, not an error — it is handled by returning
 * { status: 'NO_VIABLE_OUTCOME' } in the PlanningResult.
 *
 * If this exception is thrown, it indicates an unexpected failure in the
 * simulation infrastructure (e.g., a WKG query failed).
 */
export class NoViableOutcomeError extends PlanningException {
  constructor(message: string) {
    super(message);
    this.name = 'NoViableOutcomeError';
    Object.setPrototypeOf(this, NoViableOutcomeError.prototype);
  }
}

/**
 * Thrown when constraint validation detects one or more constraint failures.
 * This is an expected outcome, not an error — it is handled by returning
 * { status: 'VALIDATION_FAILED'; reasons: [...] } in the PlanningResult.
 *
 * If this exception is thrown, it indicates an unexpected failure in the
 * validation infrastructure (e.g., the LLM call failed unexpectedly).
 */
export class ValidationFailedError extends PlanningException {
  readonly reasons: readonly string[];

  constructor(message: string, reasons: string[]) {
    super(message);
    this.name = 'ValidationFailedError';
    this.reasons = Object.freeze([...reasons]);
    Object.setPrototypeOf(this, ValidationFailedError.prototype);
  }
}

/**
 * Thrown when the planning rate limiter has been exceeded.
 * This is an expected outcome, not an error — it is handled by returning
 * { status: 'RATE_LIMITED' } in the PlanningResult.
 *
 * If this exception is thrown, it indicates an unexpected failure in the
 * rate limiting infrastructure (e.g., state tracking failed).
 */
export class RateLimitExceededError extends PlanningException {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitExceededError';
    Object.setPrototypeOf(this, RateLimitExceededError.prototype);
  }
}

/**
 * Thrown when the opportunity queue is full and no more opportunities
 * can be enqueued.
 *
 * CANON §Known Attractor States: This is a guard against unbounded queue growth.
 */
export class QueueFullError extends PlanningException {
  constructor(message: string) {
    super(message);
    this.name = 'QueueFullError';
    Object.setPrototypeOf(this, QueueFullError.prototype);
  }
}

/**
 * Thrown when a specific stage of the planning pipeline encounters an
 * unexpected error that cannot be recovered from.
 *
 * This exception carries the name of the failed stage and an optional
 * causal error for debugging and logging.
 */
export class PipelineStageError extends PlanningException {
  readonly stageName: string;
  readonly cause?: Error;

  constructor(stageName: string, message: string, cause?: Error) {
    super(message);
    this.name = 'PipelineStageError';
    this.stageName = stageName;
    this.cause = cause;
    Object.setPrototypeOf(this, PipelineStageError.prototype);
  }
}
