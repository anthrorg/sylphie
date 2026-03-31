/**
 * Domain exception base classes — one per CANON subsystem.
 *
 * Each class pins the subsystem field to the CANON-canonical subsystem name,
 * so exception filters and log aggregators can route without string-matching
 * the message. Specific error classes extend these domain bases.
 *
 * Convention: code defaults to 'UNKNOWN' when no specific code is provided.
 * Subclasses should always pass a meaningful code.
 */

import { SylphieException } from './sylphie.exception';

// ---------------------------------------------------------------------------
// Knowledge (WKG + Grafeo KGs)
// ---------------------------------------------------------------------------

/**
 * Base for all errors originating in the Knowledge module (WKG, Self KG, Other KG).
 *
 * subsystem: 'knowledge'
 *
 * Covers Neo4j driver errors, Grafeo errors, and knowledge integrity violations
 * (missing provenance, confidence ceiling breach, contradiction detection).
 */
export class KnowledgeException extends SylphieException {
  constructor(
    message: string,
    code: string = 'UNKNOWN',
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'knowledge', code, context, cause);
  }
}

// ---------------------------------------------------------------------------
// Drive Engine
// ---------------------------------------------------------------------------

/**
 * Base for all errors originating in the Drive Engine module.
 *
 * subsystem: 'drive-engine'
 *
 * Covers IPC boundary failures, drive process unavailability, and isolation
 * violations.
 */
export class DriveException extends SylphieException {
  constructor(
    message: string,
    code: string = 'UNKNOWN',
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'drive-engine', code, context, cause);
  }
}

// ---------------------------------------------------------------------------
// Communication
// ---------------------------------------------------------------------------

/**
 * Base for all errors originating in the Communication module.
 *
 * subsystem: 'communication'
 *
 * Covers input parsing failures, LLM call errors, TTS/chatbox output errors,
 * and person modeling failures.
 */
export class CommunicationException extends SylphieException {
  constructor(
    message: string,
    code: string = 'UNKNOWN',
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'communication', code, context, cause);
  }
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

/**
 * Base for all errors originating in the Learning module.
 *
 * subsystem: 'learning'
 *
 * Covers consolidation cycle failures, entity extraction errors, and edge
 * refinement errors.
 */
export class LearningException extends SylphieException {
  constructor(
    message: string,
    code: string = 'UNKNOWN',
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'learning', code, context, cause);
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Base for all errors originating in the Planning module.
 *
 * subsystem: 'planning'
 *
 * Covers opportunity intake failures, simulation errors, plan assembly
 * failures, and LLM constraint validation errors.
 */
export class PlanningException extends SylphieException {
  constructor(
    message: string,
    code: string = 'UNKNOWN',
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'planning', code, context, cause);
  }
}

// ---------------------------------------------------------------------------
// Decision Making
// ---------------------------------------------------------------------------

/**
 * Base for all errors originating in the Decision Making module.
 *
 * subsystem: 'decision-making'
 *
 * Covers arbitration errors, episodic memory failures, prediction pipeline
 * errors, and executor state machine errors.
 */
export class DecisionMakingException extends SylphieException {
  constructor(
    message: string,
    code: string = 'UNKNOWN',
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, 'decision-making', code, context, cause);
  }
}
