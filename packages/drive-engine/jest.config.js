/** @type {import('jest').Config} */
const TSJEST = require.resolve(
  'C:/Users/Jim/AppData/Local/npm-cache/_npx/2945e3c7a38efdf6/node_modules/ts-jest',
);

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  // opportunity-queue.spec.ts is a standalone tsx / node:assert script (it defines
  // its own describe/it harness and calls process.exit), NOT a jest suite. It is
  // run directly via `npx tsx .../opportunity-queue.spec.ts`. Exclude it so jest
  // does not mis-collect it (its custom globals + process.exit would corrupt the run).
  testPathIgnorePatterns: [
    '/node_modules/',
    // Separator-agnostic: the '<rootDir>/...' form expands to backslashes on
    // Windows and fails to match jest's forward-slash-normalized test paths, so
    // jest mis-collected this standalone tsx script. Match by filename suffix.
    'opportunity-queue\\.spec\\.ts$',
  ],
  transform: {
    '^.+\\.tsx?$': [TSJEST, {
      // tsconfig.spec.json maps @sylphie/shared -> ../shared/src (live source) so
      // ts-jest does not type-check specs against a stale ../shared/dist build.
      tsconfig: '<rootDir>/tsconfig.spec.json',
    }],
  },
  moduleNameMapper: {
    '^@sylphie/shared$': '<rootDir>/../shared/src/index.ts',
  },
};
