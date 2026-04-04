/**
 * Public API barrel for DriveEngineModule.
 *
 * Other modules import exclusively from this barrel, never from internal
 * file paths. This enforces the module boundary: what is listed here is
 * the contract; everything else is an implementation detail.
 *
 * EXPORTED:
 *   DriveEngineModule              — NestJS module for DI registration
 *   DRIVE_STATE_READER             — Injection token for IDriveStateReader
 *   ACTION_OUTCOME_REPORTER        — Injection token for IActionOutcomeReporter
 *   RULE_PROPOSER                  — Injection token for IRuleProposer
 *   IDriveStateReader              — Read-only drive state interface
 *   IActionOutcomeReporter         — Action outcome reporting interface
 *   IRuleProposer                  — Drive rule proposal interface
 *   Opportunity                    — Opportunity data shape
 *   OpportunityClassification      — Opportunity classification type
 *   ProposedDriveRule              — Proposed rule shape
 *   SoftwareMetrics                — Metrics payload shape
 *
 * NOT EXPORTED (internal):
 *   DRIVE_PROCESS_MANAGER          — Internal lifecycle token
 *   IDriveProcessManager           — Internal lifecycle interface
 *   DriveReaderService             — Concrete implementation
 *   ActionOutcomeReporterService   — Concrete implementation
 *   RuleProposerService            — Concrete implementation
 *   DriveProcessManagerService     — Concrete implementation
 */

export { DriveEngineModule } from './drive-engine.module';

export {
  DRIVE_STATE_READER,
  ACTION_OUTCOME_REPORTER,
  RULE_PROPOSER,
  // DRIVE_PROCESS_MANAGER intentionally omitted
} from './drive-engine.tokens';

export type {
  IDriveStateReader,
  IActionOutcomeReporter,
  IRuleProposer,
  Opportunity,
  OpportunityClassification,
  ProposedDriveRule,
  SoftwareMetrics,
  // IDriveProcessManager intentionally omitted
} from './interfaces/drive-engine.interfaces';
