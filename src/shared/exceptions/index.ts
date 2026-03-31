/**
 * Barrel export for the shared exceptions directory.
 *
 * Consumers import exception classes from this barrel rather than from
 * internal file paths. Internal file structure is an implementation detail.
 */

export { SylphieException } from './sylphie.exception';

export {
  KnowledgeException,
  DriveException,
  CommunicationException,
  LearningException,
  PlanningException,
  DecisionMakingException,
} from './domain.exceptions';

export {
  ProvenanceMissingError,
  ConfidenceCeilingViolation,
  ContradictionDetectedError,
  DriveUnavailableError,
} from './specific.exceptions';
