/**
 * Jest config for running worktree tests with module resolution from the main repo.
 * Used when node_modules are only available via the main checkout symlinks.
 *
 * This config points roots at the worktree src but resolves @sylphie/shared
 * from the main repo's source (same as the standard jest.config.js but with
 * different rootDir resolution for the shared package).
 */
const TSJEST = require.resolve(
  'C:/Users/Jim/AppData/Local/npm-cache/_npx/2945e3c7a38efdf6/node_modules/ts-jest',
);

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  transform: {
    '^.+\\.tsx?$': [TSJEST, {
      tsconfig: '<rootDir>/tsconfig.json',
      // Skip full type diagnostics — the tsc build enforces types; tests verify behavior.
      diagnostics: false,
    }],
  },
  moduleNameMapper: {
    '^@sylphie/shared$': 'C:/Users/Jim/OneDrive/desktop/Code/sylphie/packages/shared/src/index.ts',
  },
};
