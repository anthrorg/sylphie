/**
 * Testing module barrel export.
 *
 * Consumers import from this barrel and inject by token, never by concrete class.
 * The testing module is only available in dev/test environments.
 */

export { TestingModule } from './testing.module';
export { TEST_ENVIRONMENT } from './interfaces/testing.tokens';
export type {
  ITestEnvironment,
  ILesionMode,
  TestMode,
  TestContext,
  GraphSnapshot,
  LesionResult,
  TestEvent,
  DiagnosticClassification,
} from './interfaces/testing.interfaces';
