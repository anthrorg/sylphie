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
      diagnostics: false,
    }],
  },
  moduleNameMapper: {
    '^@sylphie/shared$': '<rootDir>/../shared/src/index.ts',
    '^@sylphie/drive-engine$': '<rootDir>/../drive-engine/src/index.ts',
  },
  // Resolve peer deps (e.g. @nestjs/common) from the monorepo root's node_modules
  // so worktree runs (which have no local node_modules) can find them.
  modulePaths: ['C:/Users/Jim/OneDrive/desktop/Code/sylphie/node_modules'],
};
