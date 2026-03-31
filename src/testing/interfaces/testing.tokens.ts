/**
 * Dependency injection tokens for the Testing module.
 *
 * Symbol tokens prevent name collisions at DI registration. The Testing module
 * provides the ITestEnvironment service to test harnesses.
 *
 * Lesion modes are internal to the testing infrastructure and are not directly
 * injected by consumer code. The ITestEnvironment interface manages lesion
 * lifecycle.
 *
 * Usage:
 *   import { TEST_ENVIRONMENT } from '../testing/interfaces/testing.tokens';
 *   @Inject(TEST_ENVIRONMENT) private readonly testEnv: ITestEnvironment
 */

/** DI token for the main TestEnvironment service. */
export const TEST_ENVIRONMENT = Symbol('TEST_ENVIRONMENT');
