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
    '<rootDir>/src/drive-process/opportunity-queue.spec.ts',
  ],
  transform: {
    '^.+\\.tsx?$': [TSJEST, {
      tsconfig: '<rootDir>/tsconfig.json',
    }],
  },
  moduleNameMapper: {
    '^@sylphie/shared$': '<rootDir>/../shared/src/index.ts',
  },
};
