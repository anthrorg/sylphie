/**
 * NestJS injection tokens for the DriveEngineModule.
 *
 * Symbols are used so that the DI container can bind interfaces (not
 * concrete classes) at injection sites. Consumers import only the token
 * they need; they never reference concrete service classes directly.
 *
 * EXPORTED tokens (public API — re-exported from index.ts):
 *   DRIVE_STATE_READER      — IDriveStateReader, read-only drive state facade
 *   ACTION_OUTCOME_REPORTER — IActionOutcomeReporter, fire-and-forget IPC writes
 *   RULE_PROPOSER           — IRuleProposer, guardian-gated rule proposals
 *
 * INTERNAL token (NOT exported from index.ts):
 *   DRIVE_PROCESS_MANAGER   — IDriveProcessManager, child process lifecycle
 *   This token is only ever used inside DriveEngineModule. It is deliberately
 *   kept out of the barrel export to prevent other modules from depending on
 *   process management, which would couple them to infrastructure internals.
 */

/**
 * Injection token for IDriveStateReader.
 * Provides the read-only drive state facade to subsystem modules.
 */
export const DRIVE_STATE_READER = Symbol('DRIVE_STATE_READER');

/**
 * Injection token for IActionOutcomeReporter.
 * Provides the fire-and-forget IPC write channel for action outcomes and metrics.
 */
export const ACTION_OUTCOME_REPORTER = Symbol('ACTION_OUTCOME_REPORTER');

/**
 * Injection token for IRuleProposer.
 * Provides the guardian-gated drive rule proposal interface.
 */
export const RULE_PROPOSER = Symbol('RULE_PROPOSER');

/**
 * Injection token for IDriveProcessManager.
 * INTERNAL TO DriveEngineModule ONLY. Not exported from index.ts.
 * Used by DriveEngineModule to wire the child process lifecycle service.
 */
export const DRIVE_PROCESS_MANAGER = Symbol('DRIVE_PROCESS_MANAGER');
