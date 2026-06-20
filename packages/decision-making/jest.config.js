/** @type {import('jest').Config} */
const TSJEST = require.resolve(
  'C:/Users/Jim/AppData/Local/npm-cache/_npx/2945e3c7a38efdf6/node_modules/ts-jest',
);

// The worktree shares node_modules with the main checkout (no independent
// `yarn install` in the worktree). Point modulePaths at the main checkout so
// that NestJS / other shared packages resolve correctly.
const MAIN_NODE_MODULES = 'C:/Users/Jim/OneDrive/desktop/Code/sylphie/node_modules';

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  modulePaths: [MAIN_NODE_MODULES],
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
};
