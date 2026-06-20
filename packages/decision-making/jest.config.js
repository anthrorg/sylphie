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
  // Resolve node_modules from the main checkout — worktrees share the git objects
  // but NOT node_modules; point Jest at the installed packages in the primary tree.
  modulePaths: ['C:/Users/Jim/OneDrive/desktop/Code/sylphie/node_modules'],
};
