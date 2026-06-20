/** @type {import('jest').Config} */
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
      // diagnostics: false suppresses ts-jest type-checking errors for test globals
      // (describe/it/expect) — the production tsconfig intentionally excludes *.spec.ts
      // and @types/jest, matching the decision-making package pattern.
      diagnostics: false,
    }],
  },
  moduleNameMapper: {
    // Point shared to main repo source — worktrees don't have independent node_modules,
    // and shared's src barrel pulls in @nestjs/config, @prisma/client etc which live only
    // in the main repo's node_modules (resolved via modulePaths below).
    '^@sylphie/shared$': 'C:/Users/Jim/OneDrive/desktop/Code/sylphie/packages/shared/src/index.ts',
  },
  modulePaths: [
    // Worktrees share the yarn-installed node_modules from the main repo root.
    'C:/Users/Jim/OneDrive/desktop/Code/sylphie/node_modules',
  ],
};
