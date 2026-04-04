/**
 * SylphieException — base class for all application errors.
 *
 * Every domain exception in the system extends this class. The three required
 * fields (subsystem, code, context) ensure that any caught SylphieException
 * carries enough information to understand what failed and why, without
 * leaking database internals or driver stack traces to callers.
 *
 * subsystem: identifies the originating module at a coarse level. Matches the
 *   CANON subsystem names and enables per-subsystem exception filters.
 *
 * code: a machine-readable string unique within the subsystem. Used for
 *   programmatic error handling (retry logic, circuit breaker classification)
 *   without string-matching the message.
 *
 * context: arbitrary key-value pairs for diagnostic context. Callers should
 *   include every identifier needed to reproduce the failure from logs alone
 *   (node IDs, edge types, session IDs, etc.).
 *
 * Error.cause is set when wrapping a lower-level error (database driver
 * exception, network error) to preserve the original stack trace.
 */
export class SylphieException extends Error {
  /**
   * The originating subsystem. One of the five CANON subsystems or an
   * infrastructure name ('knowledge', 'events', 'shared').
   */
  readonly subsystem: string;

  /**
   * Machine-readable error code unique within the subsystem.
   * Examples: 'NODE_NOT_FOUND', 'DRIVE_PROCESS_UNREACHABLE', 'PROVENANCE_MISSING'
   */
  readonly code: string;

  /**
   * Diagnostic context. Every field here should be directly useful for
   * understanding the failure from a log entry.
   * Example: { nodeId: 'abc123', label: 'Jim', type: 'Person' }
   */
  readonly context: Record<string, unknown>;

  /**
   * @param message   - Human-readable description of the failure.
   * @param subsystem - The CANON subsystem that produced this error.
   * @param code      - Machine-readable error code.
   * @param context   - Diagnostic key-value pairs for logging.
   * @param cause     - Optional lower-level error being wrapped.
   */
  constructor(
    message: string,
    subsystem: string,
    code: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.subsystem = subsystem;
    this.code = code;
    this.context = context;
    // Attach cause manually. Error cause (ES2022) is not in ES2021 lib typings,
    // but the property is supported at runtime in Node 16+.
    if (cause !== undefined) {
      (this as unknown as { cause: unknown }).cause = cause;
    }
  }
}
