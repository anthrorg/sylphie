/** @type {import('jest').Config} */
const TSJEST = require.resolve(
  'C:/Users/Jim/AppData/Local/npm-cache/_npx/2945e3c7a38efdf6/node_modules/ts-jest',
);

// When running from a worktree the workspace node_modules live in the main
// checkout. Add it to the resolution search path so @nestjs/* etc. resolve.
const MAIN_REPO_NODE_MODULES = 'C:/Users/Jim/OneDrive/desktop/Code/sylphie/node_modules';

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
  modulePaths: [MAIN_REPO_NODE_MODULES],
};
