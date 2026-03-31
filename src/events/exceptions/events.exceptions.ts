/**
 * Events subsystem exceptions.
 *
 * All exceptions in the Events module extend EventsException, which in turn
 * extends SylphieException. This ensures all domain errors carry consistent
 * metadata (subsystem, code, context) for logging and programmatic handling.
 *
 * CANON §Exception Hierarchy: exceptions preserve the original cause for
 * debugging while presenting a clean public interface.
 */

import { SylphieException } from '../../shared/exceptions/sylphie.exception';

/**
 * EventsException — base class for all events subsystem errors.
 *
 * Extends SylphieException with subsystem = 'events'.
 * All specific event errors inherit from this class.
 */
export class EventsException extends SylphieException {
  /**
   * @param message - Human-readable error description
   * @param code - Machine-readable error code (e.g., 'VALIDATION_ERROR', 'STORAGE_ERROR')
   * @param context - Diagnostic key-value pairs for logs
   * @param cause - Optional underlying error being wrapped
   */
  constructor(
    message: string,
    code: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'events', code, context, cause);
    this.name = this.constructor.name;
  }
}

/**
 * EventValidationError — raised when an event violates the contract.
 *
 * Occurs when:
 * - Event type is unrecognized or invalid
 * - Subsystem source is not one of the five CANON subsystems
 * - Required fields are missing (e.g., actionId on ReinforcementEvent)
 * - Event timestamp is in the future
 * - Method not yet implemented (forwarding reference to later tickets)
 */
export class EventValidationError extends EventsException {
  constructor(
    message: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'VALIDATION_ERROR', context, cause);
  }
}

/**
 * EventStorageError — raised when TimescaleDB write fails.
 *
 * Occurs when:
 * - Connection to TimescaleDB is lost
 * - INSERT fails due to constraint violation
 * - Row lock acquisition fails
 * - Pool exhaustion or timeout
 */
export class EventStorageError extends EventsException {
  constructor(
    message: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'STORAGE_ERROR', context, cause);
  }
}

/**
 * EventQueryError — raised when a read operation fails.
 *
 * Occurs when:
 * - SELECT query times out
 * - Invalid filter combinations are provided
 * - Query results exceed memory limits
 * - TimescaleDB is unreachable during query
 */
export class EventQueryError extends EventsException {
  constructor(
    message: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'QUERY_ERROR', context, cause);
  }
}

/**
 * EventNotFoundError — raised when an event ID does not exist.
 *
 * Occurs when:
 * - markProcessed() is called on a non-existent event ID
 * - markProcessedBatch() contains an ID that doesn't exist
 * - Querying a specific event that was never inserted or was deleted
 */
export class EventNotFoundError extends EventsException {
  constructor(
    message: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'NOT_FOUND', context, cause);
  }
}
