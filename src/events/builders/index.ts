/**
 * Event builders module barrel export.
 *
 * Consumers import type-safe event builders exclusively from this path:
 *   import {
 *     createDecisionMakingEvent,
 *     createCommunicationEvent,
 *     // ... etc
 *   } from '../events/builders';
 *
 * Internal implementation files are not exported; they are implementation
 * details of the builders module.
 */

export {
  createDecisionMakingEvent,
  createCommunicationEvent,
  createLearningEvent,
  createDriveEngineEvent,
  createPlanningEvent,
  createSystemEvent,
  type EventBuildOptions,
} from './event-builders';
