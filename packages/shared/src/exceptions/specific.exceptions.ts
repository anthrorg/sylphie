/**
 * Specific exception classes for well-defined error conditions.
 *
 * These are the exceptions that service code throws and that callers
 * programmatically handle (not just log). Each carries a stable code string
 * so callers can type-switch without matching message text.
 *
 * CANON constraints enforced at the throw site:
 *   ProvenanceMissingError    — CANON §7 (Provenance Is Sacred)
 *   ConfidenceCeilingViolation — CANON Immutable Standard 3 (Confidence Ceiling)
 *   ContradictionDetectedError — CANON §Learning (contradictions are catalysts, not errors)
 *   DriveUnavailableError      — CANON §Drive Isolation (Drive Engine is separate process)
 */

import { KnowledgeException, DriveException } from './domain.exceptions';
import { SylphieException } from './sylphie.exception';

// ---------------------------------------------------------------------------
// Knowledge — Provenance
// ---------------------------------------------------------------------------

/**
 * Thrown when a WKG write operation is attempted without a provenance field.
 *
 * CANON §7 (Provenance Is Sacred): Every node and edge must carry provenance.
 * This distinction is never erased — it enables the Lesion Test. Omitting
 * provenance at the persistence boundary is a data-integrity violation.
 *
 * code: 'PROVENANCE_MISSING'
 */
export class ProvenanceMissingError extends KnowledgeException {
  /**
   * @param operation - The write operation that lacked provenance (e.g., 'upsertNode').
   * @param context   - Additional context (e.g., the labels or type being written).
   */
  constructor(operation: string, context: Record<string, unknown> = {}) {
    super(
      `Provenance is required on all WKG writes. Operation "${operation}" did not provide a provenance source.`,
      'PROVENANCE_MISSING',
      { operation, ...context },
    );
  }
}

// ---------------------------------------------------------------------------
// Knowledge — Confidence Ceiling
// ---------------------------------------------------------------------------

/**
 * Thrown when code attempts to write a confidence value that exceeds 0.60
 * for a node or edge that has not yet had a successful retrieval-and-use event.
 *
 * CANON Immutable Standard 3 (Confidence Ceiling): No knowledge exceeds 0.60
 * without successful retrieval-and-use. This ceiling is a constitutional
 * constraint — it cannot be bypassed by passing a higher initialConfidence.
 *
 * code: 'CONFIDENCE_CEILING_VIOLATION'
 */
export class ConfidenceCeilingViolation extends KnowledgeException {
  /**
   * @param attempted - The confidence value that was attempted.
   * @param ceiling   - The ceiling that was violated (typically 0.60).
   * @param context   - Additional context (e.g., node labels, provenance).
   */
  constructor(
    attempted: number,
    ceiling: number,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Confidence ceiling violation: attempted ${attempted} exceeds ceiling ${ceiling} for knowledge with no retrieval history.`,
      'CONFIDENCE_CEILING_VIOLATION',
      { attempted, ceiling, ...context },
    );
  }
}

// ---------------------------------------------------------------------------
// Knowledge — Contradiction
// ---------------------------------------------------------------------------

/**
 * Thrown (or surfaced) when a WKG upsert detects a contradiction with
 * existing knowledge.
 *
 * CANON §Learning: Contradictions are Piagetian disequilibrium — developmental
 * catalysts, not failures to suppress. The Learning subsystem emits a
 * CONTRADICTION_DETECTED event and flags the conflict for guardian review.
 *
 * Note: WKG upsert operations return a discriminated union (NodeUpsertResult /
 * EdgeUpsertResult) when contradictions are detected in the normal read path.
 * This exception is thrown when a contradiction is encountered in a code path
 * that cannot return a discriminated union (e.g., inside a transaction rollback
 * or a background consolidation task).
 *
 * code: 'CONTRADICTION_DETECTED'
 */
export class ContradictionDetectedError extends KnowledgeException {
  /**
   * @param existingId     - The ID of the existing node or edge.
   * @param incomingLabel  - Descriptive label/type of the incoming knowledge.
   * @param conflictType   - How the two pieces of knowledge conflict.
   * @param context        - Additional diagnostic context.
   */
  constructor(
    existingId: string,
    incomingLabel: string,
    conflictType: string,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Contradiction detected: incoming "${incomingLabel}" conflicts with existing node/edge (${existingId}). Conflict type: ${conflictType}.`,
      'CONTRADICTION_DETECTED',
      { existingId, incomingLabel, conflictType, ...context },
    );
  }
}

// ---------------------------------------------------------------------------
// Drive Engine — Process Unavailability
// ---------------------------------------------------------------------------

/**
 * Thrown when the Drive Engine process is unreachable via IPC.
 *
 * CANON §Drive Isolation: Drive computation runs in a separate process with
 * one-way communication. If the process is down or not yet ready, callers
 * must handle gracefully — the system cannot function without drive state.
 *
 * Callers should:
 * - Log the error with full context.
 * - Fall back to the last known DriveSnapshot if available.
 * - Emit a DRIVE_TICK event with degraded status to TimescaleDB.
 * - Attempt reconnection via the IDriveProcessManager.
 *
 * code: 'DRIVE_UNAVAILABLE'
 */
export class DriveUnavailableError extends DriveException {
  /**
   * @param reason  - Why the drive process is unreachable.
   * @param context - Additional diagnostic context (PID, last tick, etc.).
   * @param cause   - The underlying IPC or system error.
   */
  constructor(
    reason: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(
      `Drive Engine process is unavailable: ${reason}`,
      'DRIVE_UNAVAILABLE',
      { reason, ...context },
      cause,
    );
  }
}

// ---------------------------------------------------------------------------
// Drive Engine — Snapshot Coherence Validation
// ---------------------------------------------------------------------------

/**
 * Thrown when a DriveSnapshot fails coherence validation.
 *
 * DriveReaderService validates every incoming snapshot before caching it to
 * ensure the Drive Engine child process is producing valid state. Coherence
 * failures indicate either a crash or a logic error in the child process.
 *
 * Validation checks:
 * - All drive values are within [-10.0, 1.0]
 * - Not all drives are zero (indicates child crash before initialization)
 * - Snapshot timestamp is not stale (not hanging for >1s without update)
 * - totalPressure is consistent with the pressureVector
 *
 * code: 'DRIVE_COHERENCE_ERROR'
 */
export class DriveCoherenceError extends DriveException {
  /**
   * @param reason  - Specific reason the coherence check failed.
   * @param context - Diagnostic context (e.g., snapshot field values, timestamps).
   * @param cause   - Optional underlying error being wrapped.
   */
  constructor(
    reason: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(
      `Drive snapshot coherence validation failed: ${reason}`,
      'DRIVE_COHERENCE_ERROR',
      { reason, ...context },
      cause,
    );
  }
}

// ---------------------------------------------------------------------------
// Testing — Test Environment
// ---------------------------------------------------------------------------

/**
 * Thrown when the test environment cannot be bootstrapped or errors during setup.
 *
 * CANON §Phase 1 Must Prove (Lesion Test): The testing harness must reliably
 * initialize test contexts, bootstrap lesion modes, and capture graph snapshots.
 *
 * code: varies ('BOOTSTRAP_FAILED', 'SNAPSHOT_ERROR', etc.)
 */
export class TestEnvironmentError extends SylphieException {
  /**
   * @param message - Human-readable description of the failure.
   * @param code    - Machine-readable error code.
   * @param context - Diagnostic context (testId, mode, etc.).
   * @param cause   - Optional underlying error being wrapped.
   */
  constructor(
    message: string,
    code: string = 'UNKNOWN',
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'testing', code, context, cause);
  }
}

// ---------------------------------------------------------------------------
// Testing — Lesion Mode
// ---------------------------------------------------------------------------

/**
 * Thrown when a lesion mode cannot be enabled or disabled.
 *
 * CANON §Phase 1 Must Prove: Lesion tests must reliably apply and remove
 * subsystem disables. If a lesion fails to apply or cannot be removed, the
 * test results are invalid.
 *
 * code: varies ('LESION_ENABLE_FAILED', 'LESION_DISABLE_FAILED', etc.)
 */
export class LesionModeError extends SylphieException {
  /**
   * @param message - Human-readable description of the failure.
   * @param code    - Machine-readable error code.
   * @param context - Diagnostic context (lesionType, testId, etc.).
   * @param cause   - Optional underlying error being wrapped.
   */
  constructor(
    message: string,
    code: string = 'UNKNOWN',
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'testing', code, context, cause);
  }
}

// ---------------------------------------------------------------------------
// Metrics — Computation
// ---------------------------------------------------------------------------

/**
 * Thrown when health metrics cannot be computed or aggregated.
 *
 * CANON §Development Metrics: The seven primary health metrics are the
 * instrument panel for tracking autonomy. Computation failures prevent
 * monitoring and drift detection.
 *
 * code: varies ('QUERY_FAILED', 'AGGREGATION_ERROR', 'BASELINE_MISSING', etc.)
 */
export class MetricsComputationError extends SylphieException {
  /**
   * @param message - Human-readable description of the failure.
   * @param code    - Machine-readable error code.
   * @param context - Diagnostic context (sessionId, metric name, etc.).
   * @param cause   - Optional underlying error being wrapped.
   */
  constructor(
    message: string,
    code: string = 'UNKNOWN',
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'metrics', code, context, cause);
  }
}
