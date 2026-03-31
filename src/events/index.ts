/**
 * Events module public API.
 *
 * Consumers import exclusively from this barrel. Internal file paths are
 * implementation details and must not be imported directly from outside
 * the events/ directory.
 *
 * Usage:
 *   import { EventsModule, EVENTS_SERVICE } from '../events';
 *   import type { IEventService, RecordResult } from '../events';
 *   import { createDecisionMakingEvent, createCommunicationEvent } from '../events';
 */

// Module
export { EventsModule } from './events.module';

// Injection tokens
export { EVENTS_SERVICE, TIMESCALEDB_POOL } from './events.tokens';

// Exception classes
export {
  EventsException,
  EventValidationError,
  EventStorageError,
  EventQueryError,
  EventNotFoundError,
} from './exceptions/events.exceptions';

// Interfaces and supporting types
export type {
  IEventService,
  EventQueryOptions,
  EventFrequencyResult,
  EventPatternQuery,
  RecordResult,
} from './interfaces/events.interfaces';

// Event builders
export {
  createDecisionMakingEvent,
  createCommunicationEvent,
  createLearningEvent,
  createDriveEngineEvent,
  createPlanningEvent,
  createSystemEvent,
  type EventBuildOptions,
} from './builders';
